/**
 * @file lib/core.js
 * @description Bot Gateway 核心模块：TaskManager 任务管理、命令路由、会话驱动 (runTurn)、
 *              session/event 进度与工具事件监听、tasksBySession 索引优化、state.json 原子持久化与重启恢复、
 *              allowlist 与 allowGroups 安全闸门。
 */

import { writeFile, readFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger, makeUserMessage } from './util.js?v=10';

export class Gateway {
  /**
   * @param {object} ctx - Cordis 上下文
   * @param {object} config - 插件配置
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.log = createLogger('core');

    this.adapters = new Map(); // kind -> adapterInstance
    this.chats = new Map(); // chatKey -> { activeTaskId, cwd }
    this.tasks = new Map(); // taskId -> Task
    this.tasksBySession = new Map(); // sessionId -> Task (高效事件处理索引)

    this._paths = null;
    this.saveTimer = null;
    this.progressTimer = null;
    this.unsubEvents = null;
  }

  /**
   * 注册 Adapter
   */
  registerAdapter(adapter) {
    this.adapters.set(adapter.kind, adapter);
  }

  /**
   * 初始化 Gateway：载入持久化状态、开启定时任务、注册事件监听
   */
  async init() {
    await this.loadState();

    // 监听全局 session/event 事件
    this.unsubEvents = this.ctx.on('session/event', (session, event) => {
      this.handleSessionEvent(session, event);
    });

    // 诊断：捕获 agent 循环内部被吞掉的错误（kick 的 catch 不上报）
    this._diagLog = [];
    try {
      const { appendFileSync } = await import('node:fs');
      this._diag = (line) => {
        const t = new Date().toISOString();
        try { appendFileSync(this.getPaths().statePath.replace(/state\.json$/, 'debug.log'), `[${t}] ${line}\n`); } catch {}
      };
    } catch { this._diag = () => {}; }
    this.ctx.on('agent/error', (agent, payload) => {
      this._diag?.(`agent/error id=${agent?.id ?? '?'}: ${JSON.stringify(payload)?.slice(0, 800)}`);
    });
    this.ctx.on('agent/status', (agent, payload) => {
      this._diag?.(`agent/status id=${agent?.id ?? '?'}: ${JSON.stringify(payload)}`);
    });

    // 定时进度通知
    const interval = this.config.progressIntervalMs || 180000;
    if (interval > 0) {
      this.progressTimer = setInterval(() => {
        this.checkProgressNotifications();
      }, 30000); // 30s 扫描一次
    }

    this.log.info('Gateway 核心逻辑已初始化完成');
  }

  /**
   * 获取并缓存路径：tasksRoot 与 statePath (带环境探查与降级)
   */
  getPaths() {
    if (this._paths) return this._paths;

    let baseDir = null;
    try {
      const currentFileDir = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      // 尝试 1: 从 import.meta.url 向上推算 3 级
      const try1 = resolve(currentFileDir, '../../../');
      if (existsSync(join(try1, 'settings.yaml')) || existsSync(join(try1, 'sessions'))) {
        baseDir = try1;
      }
    } catch {}

    if (!baseDir) {
      try {
        // 尝试 2: 从 process.cwd() 向上推算 3 级
        const try2 = resolve(process.cwd(), '../../../');
        if (existsSync(join(try2, 'settings.yaml')) || existsSync(join(try2, 'sessions'))) {
          baseDir = try2;
        }
      } catch {}
    }

    let tasksRoot, statePath;
    if (baseDir) {
      tasksRoot = this.config.tasksRoot || join(baseDir, 'bot-gateway', 'tasks');
      statePath = this.config.statePath || join(baseDir, 'bot-gateway', 'state.json');
    } else {
      // 兜底 3: 使用插件目录下的 runtime-data
      try {
        const currentFileDir = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
        const pluginDir = resolve(currentFileDir, '..');
        tasksRoot = this.config.tasksRoot || join(pluginDir, 'runtime-data', 'tasks');
        statePath = this.config.statePath || join(pluginDir, 'runtime-data', 'state.json');
      } catch {
        tasksRoot = this.config.tasksRoot || resolve('./runtime-data/tasks');
        statePath = this.config.statePath || resolve('./runtime-data/state.json');
      }
      this.log.warn('未探查到 dsh-home 标志物 (settings.yaml/sessions)，已降级使用 runtime-data 存储路径。建议在 cordis.patch.yml 中显式指定 tasksRoot/statePath。');
    }

    this._paths = { tasksRoot, statePath };
    return this._paths;
  }

  /**
   * 注册与更新 Task 索引
   */
  registerTask(task) {
    this.tasks.set(task.id, task);
    if (task.sessionId) {
      this.tasksBySession.set(task.sessionId, task);
    }
  }

  /**
   * 从 state.json 读取恢复持久化状态
   */
  async loadState() {
    const { statePath } = this.getPaths();
    if (!existsSync(statePath)) return;

    try {
      const content = await readFile(statePath, 'utf8');
      const data = JSON.parse(content);

      if (data.chats) {
        for (const [k, v] of Object.entries(data.chats)) {
          this.chats.set(k, v);
        }
      }

      if (data.tasks) {
        for (const [id, taskData] of Object.entries(data.tasks)) {
          const task = {
            ...taskData,
            status: taskData.status === 'running' ? 'idle' : taskData.status, // 重启后重置 running 状态为 idle
            agent: null,
            dispose: null,
            chain: Promise.resolve(),
          };
          this.registerTask(task);
        }
      }
      this.log.info(`已载入历史持久化状态: ${this.chats.size} 个 Chat, ${this.tasks.size} 个 Task`);
    } catch (e) {
      this.log.error('载入 state.json 失败:', e);
    }
  }

  /**
   * 触发状态写盘（节流 2s 写入）
   */
  saveStateThrottled() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.saveStateNow();
    }, 2000);
  }

  /**
   * 立即原子持久化写入 state.json
   */
  async saveStateNow() {
    const { statePath } = this.getPaths();
    const parentDir = resolve(statePath, '..');
    try {
      await mkdir(parentDir, { recursive: true });

      const chatsObj = {};
      for (const [k, v] of this.chats.entries()) {
        chatsObj[k] = v;
      }

      const tasksObj = {};
      for (const [id, t] of this.tasks.entries()) {
        // 排除引用句柄
        const { agent, dispose, chain, ...serializable } = t;
        tasksObj[id] = serializable;
      }

      const stateData = {
        version: 1,
        chats: chatsObj,
        tasks: tasksObj,
        updatedAt: Date.now(),
      };

      const tmpPath = `${statePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(stateData, null, 2), 'utf8');
      await rename(tmpPath, statePath);
    } catch (e) {
      this.log.error('保存 state.json 抛错:', e);
    }
  }

  /**
   * 收到消息统一回调 (来自各 adapter)
   */
  async onMessage({ adapter, chatId, userId, userName, text, isGroup, reply }) {
    text = (text || '').trim();
    if (!text) return;

    const chatKey = `${adapter}:${chatId}`;
    const adapterInst = this.adapters.get(adapter);
    const adapterCfg = adapterInst?.deps?.config?.adapters?.[adapter] || this.config.adapters?.[adapter] || {};

    // 1. allowGroups 群聊允许列表校验（群聊专属；不在允许列表则静默忽略，不发送 reply 刷屏）
    if (isGroup) {
      const allowGroups = adapterCfg.allowGroups || [];
      if (allowGroups.length > 0 && !allowGroups.map(String).includes(String(chatId))) {
        this.log.info(`群聊 [${chatId}] 未在 allowGroups 允许列表中，静默忽略消息`);
        return;
      }
    }

    // 2. allowUsers 用户允许列表校验
    const allowUsers = adapterCfg.allowUsers || [];
    const isAllowed = allowUsers.length === 0 
      ? false // 空允许列表拒绝所有人
      : allowUsers.map(String).includes(String(userId));

    if (!isAllowed) {
      this.log.warn(`拒绝未授权用户 [${userId}] 的请求 (${chatKey})`);
      await reply(`未授权。你的用户标识是 ${userId}，请把它加进 cordis.patch.yml 的 allowUsers。`).catch(() => {});
      return;
    }

    // 构造/刷新 chatTarget 结构
    const chatTarget = { type: isGroup ? 'group' : 'private', id: String(chatId) };

    // 3. 命令匹配判断
    if (text.startsWith('/')) {
      await this.handleCommand({ adapter, chatId, chatKey, userId, userName, text, isGroup, reply });
      return;
    }

    // 4. 非命令普通文本消息
    let chat = this.chats.get(chatKey);
    let activeTask = chat?.activeTaskId ? this.tasks.get(chat.activeTaskId) : null;

    if (!activeTask || activeTask.status === 'stopped') {
      // 当前 Chat 无活跃任务 -> 自动新建任务
      await this.handleNewTask({ adapter, chatId, chatKey, userId, promptText: text, isGroup, reply });
    } else if (activeTask.status === 'running') {
      // 正在运行中 -> 排队通知并触发续聊链
      activeTask.chatTarget = chatTarget;
      await reply(`⏳ 任务 [${activeTask.id}] 正在运行中，新消息已加入队列，完成后将自动执行。`).catch(() => {});
      await this.continueTask(activeTask, text, reply);
    } else {
      // 空闲续聊状态 -> 重新挂载句柄并执行 runTurn
      activeTask.chatTarget = chatTarget;
      await this.continueTask(activeTask, text, reply);
    }
  }

  /**
   * 命令集解析路由
   */
  async handleCommand({ adapter, chatId, chatKey, userId, text, isGroup, reply }) {
    const spaceIdx = text.indexOf(' ');
    const cmd = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();
    const argsStr = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case '/help':
        await reply([
          '🤖 DSH Bot Gateway 命令帮助：',
          '• /new <描述> [--cwd <路径>] — 创建并开启新任务',
          '• /status [taskId] — 查看任务当前实时状态',
          '• /list — 列出当前聊天最近 10 个任务',
          '• /stop [taskId] — 停止运行中的任务',
          '• /switch <taskId> — 切换当前活跃任务',
          '• /cwd <绝对路径|reset> — 设置或重置默认工作目录',
          '• /help — 查看帮助'
        ].join('\n')).catch(() => {});
        break;

      case '/new':
        await this.handleNewTask({ adapter, chatId, chatKey, userId, rawArgs: argsStr, isGroup, reply });
        break;

      case '/status':
        await this.handleStatus({ chatKey, taskIdArg: argsStr, reply });
        break;

      case '/list':
        await this.handleList({ chatKey, reply });
        break;

      case '/stop':
        await this.handleStop({ chatKey, taskIdArg: argsStr, reply });
        break;

      case '/switch':
        await this.handleSwitch({ chatKey, taskIdArg: argsStr, reply });
        break;

      case '/cwd':
        await this.handleCwd({ chatKey, pathArg: argsStr, reply });
        break;

      default:
        await reply(`未识别的命令 "${cmd}"。请输入 /help 查看可用命令列表。`).catch(() => {});
        break;
    }
  }

  /**
   * 处理 /new 指令：创建 Task、Session、Agent
   */
  async handleNewTask({ adapter, chatId, chatKey, userId, promptText, rawArgs, isGroup = false, reply }) {
    let taskText = promptText || rawArgs || '';
    let specifiedCwd = null;

    // 解析 --cwd 选项
    if (rawArgs && rawArgs.includes('--cwd')) {
      const match = rawArgs.match(/^(.*?)\s*--cwd\s+(\S+)(.*)$/);
      if (match) {
        taskText = (match[1] + ' ' + match[3]).trim();
        specifiedCwd = match[2];
      }
    }

    if (!taskText) {
      await reply('请提供任务描述，用法：/new <任务描述> [--cwd <绝对路径>]').catch(() => {});
      return;
    }

    const taskId = randomUUID().replace(/-/g, '').slice(0, 4);
    const { tasksRoot } = this.getPaths();

    // 确立 workspaceDir 优先级: --cwd > chat.cwd > 默认 tasksRoot/日期-id-slug
    let chat = this.chats.get(chatKey) || { activeTaskId: null, cwd: null };
    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = taskText.slice(0, 15).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const defaultDir = join(tasksRoot, `${dateStr}-${taskId}-${slug}`);

    const workspaceDir = resolve(specifiedCwd || chat.cwd || defaultDir);

    try {
      await mkdir(workspaceDir, { recursive: true });
    } catch (e) {
      await reply(`❌ 无法创建工作目录 "${workspaceDir}": ${e.message}`).catch(() => {});
      return;
    }

    const sessionId = randomUUID();
    const task = {
      id: taskId,
      chatKey,
      adapter,
      chatId,
      userId,
      chatTarget: { type: isGroup ? 'group' : 'private', id: String(chatId) },
      sessionId,
      title: taskText.slice(0, 40),
      workspaceDir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      agent: null,
      dispose: null,
      lastError: null,
      turnStartedAt: 0,
      lastProgressAt: 0,
      currentTool: '',
      toolCalls: 0,
      todoSummary: '',
      lastAssistantText: '',
      chain: Promise.resolve(),
    };

    this.registerTask(task);
    chat.activeTaskId = taskId;
    this.chats.set(chatKey, chat);
    this.saveStateThrottled();

    // 确保与 DSH 真实运行机制一致挂载 session 与 agent
    const attachOk = await this.ensureAgentHandle(task, reply);
    if (!attachOk) return;

    // 首次提示词前置远程上下文通知
    const fullPrompt = `（你正在为远程 IM 用户执行任务。交互通道是聊天软件：无法弹窗提问，如需澄清请直接以文本提问并结束本轮；任务完成时给出简明结果摘要。）\n\n${taskText}`;

    await this.runTurn(task, fullPrompt, reply);
  }

  /**
   * 确保 Task 拥有可用的 DSH Agent 句柄。
   * 严格对齐 dsh-host-apiproxy 的 ensureSession 模式：
   *   1) agents.get(sessionId) 活跃句柄直接复用；
   *   2) 持久化里已存在该会话（重启恢复）→ agents.resume；
   *   3) 全新会话 → agents.create（其内部 prepare+enter 会自行建会话，
   *      绝不能提前 sessions.create，否则 enter 抛 "already exists"）。
   */
  async ensureAgentHandle(task, reply) {
    if (task.agent) return true;

    try {
      const agents = this.ctx.get('agents');
      if (!agents) {
        throw new Error('DSH 核心服务 ctx.agents 未准备好');
      }

      // 模型选择：config.model 优先，否则全局默认模型服务
      const defaultModelService = this.ctx.get('agentDefaultModel');
      const selection = this.config.model?.provider
        ? this.config.model
        : (defaultModelService?.currentSelection?.() || {});
      const agentOptions = (selection.provider && selection.model)
        ? { provider: selection.provider, model: selection.model }
        : undefined;

      // Agent Preset 组装（对齐 apiproxy composeAgent）：preset 挂载工具集与能力，
      // 不挂载则模型没有任何工具可用，只会空谈而无法执行任务。
      const presets = this.ctx.get('agentPresets');
      let presetId = undefined;
      if (presets && typeof presets.resolve === 'function') {
        try {
          presetId = (await presets.resolve(this.config.agentPreset || undefined)).id;
        } catch (e) {
          this.log.warn(`解析 agent preset 失败（将退化为无工具 agent）: ${e.message}`);
        }
      }
      // 注意：setup 的返回值会被 agent 工厂调 .commit()，必须返回 undefined
      // （不能把 presets.mount 的返回值透传出去）。
      const composeSetup = async (agentCtx) => {
        if (!presets || presetId === undefined) return;
        await presets.mount(agentCtx, presetId);
      };

      // 1) 活跃 agent 直接复用
      const live = agents.get(task.sessionId);
      if (live && live.agent) {
        task.agent = live.agent;
        task.dispose = live.dispose;
        return true;
      }

      // 2) 已持久化的会话 → resume 恢复
      const persistence = this.ctx.get('sessionPersistence');
      if (persistence && typeof persistence.list === 'function') {
        try {
          const stored = (await persistence.list()).find((h) => h && h.id === task.sessionId);
          if (stored) {
            this.log.info(`Task [${task.id}] 命中持久化会话，resume 恢复`);
            const resumed = await agents.resume({
              resumeSessionId: task.sessionId,
              ...(agentOptions ? { agentOptions } : {}),
              setup: composeSetup,
            });
            task.agent = resumed.agent;
            task.dispose = resumed.dispose;
            return true;
          }
        } catch (e) {
          // resume 失败（如持久化损坏）则退回 create 路径重新开轮
          this.log.warn(`Task [${task.id}] resume 失败，退回 create: ${e.message}`);
        }
      }

      // 3) 全新会话 → create（工作区目录必须先存在，apiProxy 亦如此）
      const { mkdir } = await import('node:fs/promises');
      await mkdir(task.workspaceDir, { recursive: true });

      const created = await agents.create({
        sessionId: task.sessionId,
        ...(agentOptions ? { agentOptions } : {}),
        meta: {
          cwd: task.workspaceDir,
          ...(presetId !== undefined ? { agentPreset: presetId } : {})
        },
        setup: composeSetup,
      });

      task.agent = created.agent;
      task.dispose = created.dispose;
      // 诊断：挂在 agent 自身作用域内接收被吞掉的循环错误
      try {
        created.agent.ctx?.on?.('agent/error', (payload) => {
          this._diag?.(`[agent/error] session=${task.sessionId} ${JSON.stringify(payload)?.slice(0, 900)}`);
        });
      } catch {}
      this._diag?.(`[attach] task=${task.id} agent mounted, sessionId=${task.sessionId}, preset=${presetId ?? 'none'}`);
      return true;

    } catch (e) {
      this.log.error(`为 Task [${task.id}] 挂载 DSH Agent 失败:`, e);
      task.status = 'error';
      task.lastError = e.message;
      if (reply) await reply(`❌ [${task.id}] 建立任务会话失败: ${e.message}`).catch(() => {});
      return false;
    }
  }

  /**
   * 续聊处理
   */
  async continueTask(task, promptText, reply) {
    const ok = await this.ensureAgentHandle(task, reply);
    if (!ok) return;
    await this.runTurn(task, promptText, reply);
  }

  /**
   * 会话驱动 runTurn 实现
   */
  runTurn(task, promptText, reply) {
    // 串行 Promise 链保障
    task.chain = task.chain.then(async () => {
      task.status = 'running';
      task.turnStartedAt = Date.now();
      task.lastProgressAt = Date.now();
      task.toolCalls = 0;
      task.updatedAt = Date.now();
      this.saveStateThrottled();

      if (this.config.turnStartNotify && reply) {
        await reply(`▶️ [${task.id}] 开始执行：${task.title}`).catch(() => {});
      }

      const sessions = this.ctx.get('sessions');

      try {
        const userMsg = makeUserMessage(promptText);
        this._diag?.(`[turn] task=${task.id} followup 前事件数=${task.agent.session?.events?.length ?? '?'}, phase=${task.agent.phase?.kind ?? '?'}`);
        task.agent.followup(userMsg);
        this._diag?.(`[turn] task=${task.id} followup 已提交, inbox pending=${task.agent.inbox?.hasPending ?? '?'}`);

        // 诊断采样：头 6 秒每 500ms 记录事件数与 phase
        let n = 0;
        const sampler = setInterval(() => {
          n++;
          this._diag?.(`[sample] task=${task.id} t=${n * 0.5}s events=${task.agent.session?.events?.length ?? '?'} phase=${task.agent.phase?.kind ?? '?'} status=${task.agent.status ?? '?'}`);
          if (n >= 12) clearInterval(sampler);
        }, 500);

        // 超时保护
        if (this.config.turnTimeoutMs > 0) {
          const timeout = setTimeout(() => {
            if (task.status === 'running') {
              task.agent.cancel('timeout');
            }
          }, this.config.turnTimeoutMs);

          await task.agent.whenIdle();
          clearTimeout(timeout);
        } else {
          await task.agent.whenIdle();
        }

        if (sessions && task.agent.session) {
          await sessions.flush(task.agent.session);
        }

        // 提取最终回复文本
        const finalText = this.extractFinalText(task.agent.session);
        this._diag?.(`[turn] task=${task.id} whenIdle 完成 events=${task.agent.session?.events?.length ?? '?'} finalText=${JSON.stringify((finalText || '').slice(0, 200))}`);
        const evTypes = (task.agent.session?.events ?? []).slice(-8).map((e) => e.type);
        this._diag?.(`[turn] task=${task.id} 尾部事件类型: ${evTypes.join(',')}`);
        task.status = 'idle';
        task.updatedAt = Date.now();
        this.saveStateThrottled();

        if (reply) {
          await reply(finalText || '（本轮任务执行完成，无新文本输出）').catch(() => {});
        }

      } catch (e) {
        task.status = 'error';
        task.lastError = String(e?.message || e);
        task.updatedAt = Date.now();
        this.saveStateThrottled();
        this._diag?.(`[turn] task=${task.id} 异常: ${task.lastError}\n${String(e?.stack || '').slice(0, 1500)}`);

        if (reply) {
          await reply(`❌ [${task.id}] 执行中断或失败：${task.lastError}`).catch(() => {});
        }
      }
    });

    return task.chain;
  }

  /**
   * 扫描 Session 历史事件提取最终回复文本
   */
  extractFinalText(session) {
    if (!session || !Array.isArray(session.events)) return '';

    let text = '';
    // 逆序查找最后一个 assistant/message 类型的事件
    for (let i = session.events.length - 1; i >= 0; i--) {
      const ev = session.events[i];
      if (ev.type === 'assistant/message' && ev.data?.message?.content) {
        const content = ev.data.message.content;
        if (Array.isArray(content)) {
          text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        } else if (typeof content === 'string') {
          text = content;
        }
        if (text) break;
      }
    }
    // 剥离 DSML 控制标签（模型偶发把 <｜｜DSML｜｜…> 协议标签当正文输出）
    text = text.replace(/<｜｜DSML｜｜[^>]*>[^<]*<\/｜｜DSML｜｜[^>]*>/g, '');
    text = text.replace(/<\/?｜｜DSML｜｜[^>]*>/g, '');
    return text.trim();
  }

  /**
   * /status 命令处理
   */
  async handleStatus({ chatKey, taskIdArg, reply }) {
    let task = null;
    if (taskIdArg) {
      task = this.tasks.get(taskIdArg);
    } else {
      const chat = this.chats.get(chatKey);
      if (chat?.activeTaskId) {
        task = this.tasks.get(chat.activeTaskId);
      }
    }

    if (!task) {
      await reply('未找到相关任务。使用 /list 查看所有任务或 /new 创建新任务。').catch(() => {});
      return;
    }

    const duration = task.turnStartedAt > 0 ? `${Math.floor((Date.now() - task.turnStartedAt) / 1000)}s` : '未开始';
    const lastTail = task.lastAssistantText ? task.lastAssistantText.slice(-200) : '无';

    const info = [
      `📊 任务状态 [${task.id}]`,
      `• 标题: ${task.title}`,
      `• 状态: ${task.status}`,
      `• 运行时间: ${duration}`,
      `• 工具调用数: ${task.toolCalls}`,
      `• 最近工具: ${task.currentTool || '无'}`,
      task.todoSummary ? `• Todo: ${task.todoSummary}` : null,
      `• 状态详情/尾部输出: ${lastTail}`
    ].filter(Boolean).join('\n');

    await reply(info).catch(() => {});
  }

  /**
   * /list 命令处理：显示当前 chat 最近 10 个任务
   */
  async handleList({ chatKey, reply }) {
    const chatTasks = Array.from(this.tasks.values())
      .filter((t) => t.chatKey === chatKey)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    if (chatTasks.length === 0) {
      await reply('当前聊天暂无任何任务，发送 /new 创建一个。').catch(() => {});
      return;
    }

    const lines = chatTasks.map((t) => {
      const activeFlag = this.chats.get(chatKey)?.activeTaskId === t.id ? ' (当前)' : '';
      return `• [${t.id}] ${t.status.toUpperCase()}${activeFlag} — ${t.title}`;
    });

    await reply(`📋 当前聊天任务列表 (近 10 个):\n${lines.join('\n')}`).catch(() => {});
  }

  /**
   * /stop 命令处理
   */
  async handleStop({ chatKey, taskIdArg, reply }) {
    let task = null;
    if (taskIdArg) {
      task = this.tasks.get(taskIdArg);
    } else {
      const chat = this.chats.get(chatKey);
      if (chat?.activeTaskId) {
        task = this.tasks.get(chat.activeTaskId);
      }
    }

    if (!task) {
      await reply('未找到要停止的任务。').catch(() => {});
      return;
    }

    if (task.agent) {
      try {
        task.agent.cancel('用户远程停止');
      } catch (e) {
        this.log.warn('取消 agent 抛错:', e);
      }
    }

    task.status = 'stopped';
    this.saveStateThrottled();
    await reply(`🛑 任务 [${task.id}] 已停止。`).catch(() => {});
  }

  /**
   * /switch 命令处理
   */
  async handleSwitch({ chatKey, taskIdArg, reply }) {
    if (!taskIdArg) {
      await reply('用法: /switch <taskId>').catch(() => {});
      return;
    }

    const task = this.tasks.get(taskIdArg);
    if (!task || task.chatKey !== chatKey) {
      await reply(`未在此聊天找到 ID 为 "${taskIdArg}" 的任务。`).catch(() => {});
      return;
    }

    let chat = this.chats.get(chatKey) || {};
    chat.activeTaskId = task.id;
    this.chats.set(chatKey, chat);
    this.saveStateThrottled();

    await reply(`🔀 已把当前活跃任务切换至 [${task.id}] (${task.title})`).catch(() => {});
  }

  /**
   * /cwd 命令处理
   */
  async handleCwd({ chatKey, pathArg, reply }) {
    let chat = this.chats.get(chatKey) || {};

    if (!pathArg) {
      await reply(`当前设定的默认 cwd 为: ${chat.cwd || '未设定 (使用默认)'}`).catch(() => {});
      return;
    }

    if (pathArg === 'reset') {
      chat.cwd = null;
      this.chats.set(chatKey, chat);
      this.saveStateThrottled();
      await reply('已重置默认工作目录。后续 /new 将使用系统默认路径。').catch(() => {});
      return;
    }

    const absolutePath = resolve(pathArg);
    chat.cwd = absolutePath;
    this.chats.set(chatKey, chat);
    this.saveStateThrottled();

    await reply(`📁 已设置该聊天的默认工作目录为: ${absolutePath}`).catch(() => {});
  }

  /**
   * 处理 session/event 监听回调 (使用 tasksBySession 快速 Map 查找)
   */
  handleSessionEvent(session, event) {
    if (!session || !event) return;

    // 直接在 Map 索引中高效匹配 task
    const task = this.tasksBySession.get(session.id);
    if (!task) return;

    if (event.type === 'tool/call' && event.data) {
      const name = event.data.name || '';
      const args = event.data.arguments || {};
      const argsSummary = typeof args === 'object' ? JSON.stringify(args).slice(0, 40) : String(args).slice(0, 40);

      task.currentTool = `${name}(${argsSummary})`;
      task.toolCalls = (task.toolCalls || 0) + 1;

      // 解析 todo_write
      if (name === 'todo_write' && args.todos && Array.isArray(args.todos)) {
        const total = args.todos.length;
        const doneCount = args.todos.filter((td) => td.status === 'completed' || td.completed).length;
        task.todoSummary = `⏳${total - doneCount} ✅${doneCount}`;
      }
    } else if (event.type === 'assistant/message' && event.data?.message?.content) {
      const content = event.data.message.content;
      if (Array.isArray(content)) {
        task.lastAssistantText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      }
    }
  }

  /**
   * 扫描并触发长时运行任务的定时进度通知 (带防刷屏机制与正确 chatTarget)
   */
  checkProgressNotifications() {
    const interval = this.config.progressIntervalMs || 180000;
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.turnStartedAt > 0) {
        const lastNotify = task.lastProgressAt || task.turnStartedAt;
        if (now - lastNotify >= interval) {
          task.lastProgressAt = now; // 仅触发一次，防止 30s 扫描防刷屏

          const minutes = Math.floor((now - task.turnStartedAt) / 60000);
          const adapterInst = this.adapters.get(task.adapter);
          if (adapterInst) {
            const target = task.chatTarget || { type: 'private', id: task.chatId };
            const msg = `⏳ [${task.id}] 已运行 ${minutes}m · 工具调用 ${task.toolCalls || 0} 次 · 正在 ${task.currentTool || '执行'} ${task.todoSummary ? '· todo ' + task.todoSummary : ''}`;
            adapterInst.sendText(target, msg).catch(() => {});
          }
        }
      }
    }
  }

  /**
   * 获取所有注册 Adapter 的实时状态列表
   */
  getAdapterStatuses() {
    return Array.from(this.adapters.values()).map((a) => ({
      kind: a.kind,
      ...a.status(),
    }));
  }

  /**
   * 获取最近 Task 列表 (用于 WebUI)
   */
  getRecentTasks(limit = 20) {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(({ agent, dispose, chain, ...safeTask }) => safeTask);
  }

  /**
   * 获取脱敏后的配置信息
   */
  getSanitizedConfig() {
    const clone = JSON.parse(JSON.stringify(this.config));
    if (clone.adapters) {
      for (const a of Object.values(clone.adapters)) {
        if (a.accessToken) a.accessToken = '***';
        if (a.clientSecret) a.clientSecret = '***';
        if (a.token) a.token = '***';
        if (a.appSecret) a.appSecret = '***';
      }
    }
    return clone;
  }

  /**
   * Gateway 完整资源清理
   */
  async dispose() {
    this.log.info('开始清理 Gateway 资源...');

    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (typeof this.unsubEvents === 'function') {
      this.unsubEvents();
      this.unsubEvents = null;
    }

    // 释放所有已挂载的 Agent 句柄
    for (const task of this.tasks.values()) {
      if (typeof task.dispose === 'function') {
        try {
          task.dispose();
        } catch (e) {
          this.log.warn(`释放 Task [${task.id}] agent 句柄失败:`, e);
        }
      }
      task.agent = null;
      task.dispose = null;
    }

    this.tasksBySession.clear();

    // 保存最终状态
    await this.saveStateNow();
    this.log.info('Gateway 资源清理完成');
  }
}

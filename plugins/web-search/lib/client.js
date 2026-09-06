// web-search-panel — client half（浏览器花名册经 dsh-home/node_modules 裸包名
// junction 加载；改本文件后刷新浏览器即生效，无需重启）。
//
// 在 设置→插件（settings.plugin.item 键控槽位，key = "web-search"）注册
// 「网页搜索」配置卡片：总开关 / 各引擎开关 / 默认引擎 / 条数 / 超时 / UA，
// 读写走产品 settingsScope（remote.settings.mutate → settings.yaml，热生效），
// 附「测试」按钮调 host 的 /web-search/test 实测引擎连通性。
//
// 纪律（沿用 dsh-model-status 踩坑结论）：
//   1) inject 只写 ["slots", "settingsScope"]——客户端没有 timer 服务；
//   2) 不触碰 ctx/scope 的 interval 属性；
//   3) 自带 zh/en 字典，不依赖 locale 座位契约；
//   4) 组件自包含（数据从闭包 scope 取，不依赖外部 props 契约）；
//   5) 注册失败回退 slots.inject 等待 + 延迟重试。
window.__ModuleLoader__.load({
	id: "web-search-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 诊断（桌面版无 DevTools 时在控制台看 window.__webSearchPanel）。
		const diag = {
			module: "loaded",
			applied: false,
			registered: false,
			rendered: 0,
			lastError: null
		};
		if (typeof window !== "undefined") window.__webSearchPanel = diag;

		try {
			const react = require("react");

			const NS = "web-search";

			// 与 host 半边 schema 相同的默认值（卡片「恢复默认」用；host 是权威）。
			const DEFAULTS = {
				enabled: true,
				defaultEngine: "auto",
				enableDdgApi: true,
				enableDdgHtml: true,
				enableBing: true,
				enableBaidu: true,
				enableSo360: true,
				enableBrave: true,
				enableWikipedia: true,
				apiInAuto: true,
				tavilyApiKey: "",
				serperApiKey: "",
				braveApiKey: "",
				exaApiKey: "",
				maxResults: 10,
				timeoutMs: 20000,
				userAgent: ""
			};

			const ENGINE_FIELDS = [
				["enableBing", "bing", "Bing 抓取 · 大陆可达"],
				["enableBaidu", "baidu", "百度抓取 · 中文搜索"],
				["enableSo360", "so360", "360 搜索抓取 · 中文"],
				["enableDdgHtml", "ddg-html", "DuckDuckGo HTML 抓取 · 通用搜索"],
				["enableBrave", "brave", "Brave 抓取 · 独立索引"],
				["enableDdgApi", "ddg-api", "DuckDuckGo IA API · 事实快答"],
				["enableWikipedia", "wikipedia", "Wikipedia API · 百科（部分地区不可达）"]
			];

			const API_KEY_FIELDS = [
				["serperApiKey", "Serper.dev", "Google 结果 API"],
				["tavilyApiKey", "Tavily", "LLM 优化搜索 API"],
				["braveApiKey", "Brave Search API", "官方 API（与抓取版独立）"],
				["exaApiKey", "Exa", "神经/语义搜索 API"]
			];

			const ENGINE_IDS = ["auto", "ddg-html", "bing", "baidu", "so360", "brave", "ddg-api", "wikipedia", "serper", "tavily", "brave-api", "exa"];

			const zh = {
				title: "网页搜索（多引擎增强）",
				description: "web_search_multi / web_fetch_url 工具的引擎与参数。保存后立即生效（写入 settings.yaml 的 web-search 节）。",
				enabled: "启用网页搜索",
				engines: "免费搜索引擎（auto 回退链仅使用启用项）",
				defaultEngine: "默认引擎",
				engineAuto: "auto（语言感知回退）",
				maxResults: "默认返回条数（1-50）",
				timeoutMs: "单引擎超时（毫秒，3000-90000）",
				userAgent: "抓取 User-Agent（留空 = 内置 Chrome UA）",
				apiSection: "API-key 型引擎（可选，配置 key 后启用）",
				apiInAuto: "auto 链优先使用已配置 key 的 API 引擎（消耗配额）",
				apiKeyNote: "key 仅存本机 settings.yaml；/web-search/health 已打码。API 引擎质量最高（Serper=Google 结果）。",
				save: "保存",
				saving: "保存中…",
				discard: "放弃修改",
				reset: "恢复默认",
				overridden: "已覆盖默认值",
				test: "测试引擎",
				testing: "测试中…",
				testPlaceholder: "测试关键词，默认 deepseek",
				loading: "读取设置…",
				unavailable: "设置命名空间不可用：host 半边未挂载（检查家级 cordis.patch.yml 的 web-search 行，并重启 DSH）。",
				readonly: "设置只读（远端不可写）。",
				saved: "已保存",
				dirtyHint: "有未保存的修改",
				testOk: (engine, count) => `引擎 ${engine} 返回 ${count} 条：`,
				testFail: (engine, error) => `引擎 ${engine} 失败：${error}`,
				autoChain: "auto 链：中文 Bing→百度→360→DDG；英文 DDG HTML→Bing→Brave；有 key 的 API 引擎优先"
			};
			const en = {
				title: "Web Search (multi-engine)",
				description: "Engines and parameters for the web_search_multi / web_fetch_url tools. Saved live into the web-search section of settings.yaml.",
				enabled: "Enable web search",
				engines: "Free search engines (auto chain uses enabled ones only)",
				defaultEngine: "Default engine",
				engineAuto: "auto (language-aware fallback)",
				maxResults: "Default result count (1-50)",
				timeoutMs: "Per-engine timeout (ms, 3000-90000)",
				userAgent: "Fetch User-Agent (empty = built-in Chrome UA)",
				apiSection: "API-key engines (optional, enabled once a key is set)",
				apiInAuto: "Prefer keyed API engines in the auto chain (burns quota)",
				apiKeyNote: "Keys stay in the local settings.yaml; /web-search/health masks them. API engines have the best quality (Serper = Google results).",
				save: "Save",
				saving: "Saving…",
				discard: "Discard",
				reset: "Reset to defaults",
				overridden: "Overrides default",
				test: "Test engine",
				testing: "Testing…",
				testPlaceholder: "Test query, default: deepseek",
				loading: "Loading settings…",
				unavailable: "Settings namespace unavailable: the host half is not mounted (check the web-search row in the home-level cordis.patch.yml, then restart DSH).",
				readonly: "Read-only (remote not writable).",
				saved: "Saved",
				dirtyHint: "Unsaved changes",
				testOk: (engine, count) => `Engine ${engine} returned ${count} results:`,
				testFail: (engine, error) => `Engine ${engine} failed: ${error}`,
				autoChain: "auto chain: Chinese Bing→Baidu→So360→DDG; others DDG HTML→Bing→Brave; keyed API engines first"
			};
			const dict = () =>
				String((typeof navigator !== "undefined" && navigator.language) || "").toLowerCase().startsWith("zh") ? zh : en;

			const CSS = [
				".wsp-card{display:grid;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-surface-raised,transparent)}",
				".wsp-head h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
				".wsp-head p{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-caption,#8b8b8b)}",
				".wsp-row{display:flex;align-items:center;gap:10px;font-size:13px}",
				".wsp-row>label:first-child{flex:0 0 190px;color:var(--dsw-alias-label-secondary,inherit)}",
				".wsp-ov{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-state-warning-primary,#f5a623)}",
				".wsp-input,.wsp-select{height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:var(--dsw-alias-input-bg,transparent);color:inherit;font:inherit;font-size:13px}",
				".wsp-input:focus,.wsp-select:focus{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l4,rgba(127,127,127,.5))}",
				".wsp-check{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;font-size:13px;cursor:pointer}",
				".wsp-check:hover{background:var(--dsh-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
				".wsp-engines{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:4px}",
				".wsp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".wsp-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:var(--dsw-alias-interactive-bg-accent,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;cursor:pointer}",
				".wsp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22))}",
				".wsp-btn:disabled{opacity:.5;cursor:not-allowed}",
				".wsp-btn--primary{background:var(--dsw-alias-state-accent-primary,#3b82f6);border-color:transparent;color:#fff}",
				".wsp-btn--primary:hover:not(:disabled){filter:brightness(1.08)}",
				".wsp-note{font-size:12px;color:var(--dsw-alias-label-caption,#8b8b8b)}",
				".wsp-status{font-size:12px}",
				".wsp-status--ok{color:var(--dsw-alias-state-success-primary,#2ea043)}",
				".wsp-status--err{color:var(--dsw-alias-state-error-primary,#e5484d)}",
				".wsp-test{display:grid;gap:6px;padding:10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-muted,rgba(127,127,127,.07));font-size:12px;line-height:1.5}",
				".wsp-test a{color:var(--dsw-alias-state-accent-primary,#3b82f6);text-decoration:none}",
				".wsp-hint{font-size:11px;color:var(--dsw-alias-label-caption,#8b8b8b)}"
			].join("");
			if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"web-search-panel\"]") === null) {
				const tag = document.createElement("style");
				tag.setAttribute("data-plugin", "web-search-panel");
				tag.setAttribute("data-plugin-css", "web-search-panel");
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}

			// apply() 里绑定；组件从闭包取。
			let boundScope = null;

			/** 订阅 scope 快照（useState+useEffect 版本，全 React 兼容）。 */
			function useScopeSnapshot(scope) {
				const [snap, setSnap] = react.useState(() => scope.getSnapshot());
				react.useEffect(() => {
					setSnap(scope.getSnapshot());
					return scope.subscribe(() => setSnap(scope.getSnapshot()));
				}, [scope]);
				return snap;
			}

			function Ov({ show, label }) {
				if (!show) return null;
				return react.createElement("span", { className: "wsp-ov", title: label }, "● ", label);
			}

			function WebSearchCard(_props) {
				diag.rendered += 1;
				const t = dict();
				const scope = boundScope;
				if (scope === null) {
					return react.createElement("p", { className: "wsp-note" }, "web-search-panel: scope not bound");
				}
				const snap = useScopeSnapshot(scope);

				// staged 表单：以快照 revision 为同步锚点，非编辑态跟随远端。
				const value = (snap && snap.value) || {};
				const [staged, setStaged] = react.useState(() => ({ ...value }));
				const [dirty, setDirty] = react.useState(false);
				const [syncedRevision, setSyncedRevision] = react.useState(snap && snap.revision);
				react.useEffect(() => {
					if (!dirty && snap && snap.revision !== syncedRevision) {
						setStaged({ ...(snap.value || {}) });
						setSyncedRevision(snap.revision);
					}
				}, [snap, dirty, syncedRevision]);

				const [busy, setBusy] = react.useState(false);
				const [note, setNote] = react.useState(null); // {kind:'ok'|'err', text}
				const [testState, setTestState] = react.useState(null); // {busy, result}

				if (snap == null || snap.status === "loading") {
					return react.createElement("div", { className: "wsp-card" }, react.createElement("p", { className: "wsp-note" }, t.loading));
				}
				if (snap.status !== "ready") {
					return react.createElement(
						"div",
						{ className: "wsp-card" },
						react.createElement("div", { className: "wsp-head" }, react.createElement("h3", null, t.title)),
						react.createElement("p", { className: "wsp-status wsp-status--err" }, t.unavailable)
					);
				}

				const userLayer = snap.user || {};
				const writable = snap.writable !== false;
				const set = (field, v) => {
					setStaged((prev) => ({ ...prev, [field]: v }));
					setDirty(true);
				};

				const buildOps = () => {
					const ops = [];
					for (const key of Object.keys(DEFAULTS)) {
						const next = staged[key];
						const cur = value[key];
						const same = next === cur || (next == null && cur == null);
						if (same) continue;
						ops.push({ op: "set", path: [key], value: next == null ? DEFAULTS[key] : next });
					}
					return ops;
				};

				const save = async () => {
					const ops = buildOps();
					if (ops.length === 0) {
						setDirty(false);
						return;
					}
					setBusy(true);
					setNote(null);
					try {
						await scope.mutate(ops, snap.revision);
						setDirty(false);
						setNote({ kind: "ok", text: t.saved });
					} catch (e) {
						setNote({ kind: "err", text: String((e && e.message) || e) });
					} finally {
						setBusy(false);
					}
				};

				const discard = () => {
					setStaged({ ...value });
					setDirty(false);
					setNote(null);
				};

				const resetAll = async () => {
					setBusy(true);
					setNote(null);
					try {
						await scope.mutate(Object.keys(DEFAULTS).map((key) => ({ op: "unset", path: [key] })), snap.revision);
						setDirty(false);
						setNote({ kind: "ok", text: t.saved });
					} catch (e) {
						setNote({ kind: "err", text: String((e && e.message) || e) });
					} finally {
						setBusy(false);
					}
				};

				const runTest = async () => {
					const q = String((staged.__testQuery || "")).trim() || "deepseek";
					const engine = staged.defaultEngine || "auto";
					setTestState({ busy: true, engine });
					try {
						const res = await fetch(`/web-search/test?q=${encodeURIComponent(q)}&engine=${encodeURIComponent(engine)}`);
						const data = await res.json();
						setTestState({ busy: false, data });
					} catch (e) {
						setTestState({ busy: false, data: { error: String((e && e.message) || e) } });
					}
				};

				const disabled = !writable || busy;

				const row = (label, control, ovKey) =>
					react.createElement(
						"div",
						{ className: "wsp-row" },
						react.createElement("label", null, label),
						control,
						react.createElement(Ov, { show: Object.prototype.hasOwnProperty.call(userLayer, ovKey), label: t.overridden })
					);

				return react.createElement(
					"div",
					{ className: "wsp-card" },
					react.createElement(
						"div",
						{ className: "wsp-head" },
						react.createElement("h3", null, t.title),
						react.createElement("p", null, t.description)
					),

					// 总开关
					react.createElement(
						"div",
						{ className: "wsp-row" },
						react.createElement("label", null, t.enabled),
						react.createElement("input", {
							type: "checkbox",
							checked: staged.enabled !== false,
							disabled: disabled,
							onChange: (e) => set("enabled", e.target.checked)
						}),
						react.createElement(Ov, { show: Object.prototype.hasOwnProperty.call(userLayer, "enabled"), label: t.overridden })
					),

					// 引擎开关
					react.createElement(
						"div",
						null,
						react.createElement("div", { className: "wsp-row" }, react.createElement("label", null, t.engines)),
						react.createElement(
							"div",
							{ className: "wsp-engines" },
							ENGINE_FIELDS.map(([field, id, label]) =>
								react.createElement(
									"label",
									{ key: field, className: "wsp-check" },
									react.createElement("input", {
										type: "checkbox",
										checked: staged[field] !== false,
										disabled: disabled,
										onChange: (e) => set(field, e.target.checked)
									}),
									react.createElement("span", null, label)
								)
							)
						),
						react.createElement("p", { className: "wsp-hint" }, t.autoChain)
					),

					// API-key 引擎区
					react.createElement(
						"div",
						null,
						react.createElement("div", { className: "wsp-row" }, react.createElement("label", null, t.apiSection)),
						react.createElement(
							"div",
							{ style: { display: "grid", gap: "6px" } },
							API_KEY_FIELDS.map(([field, name, desc]) =>
								row(
									`${name} API key`,
									react.createElement("input", {
										className: "wsp-input",
										type: "password",
										style: { flex: "1", minWidth: "220px" },
										placeholder: desc,
										autoComplete: "off",
										value: staged[field] == null ? "" : staged[field],
										disabled: disabled,
										onChange: (e) => set(field, e.target.value)
									}),
									field
								)
							),
							react.createElement(
								"label",
								{ className: "wsp-check" },
								react.createElement("input", {
									type: "checkbox",
									checked: staged.apiInAuto !== false,
									disabled: disabled,
									onChange: (e) => set("apiInAuto", e.target.checked)
								}),
								react.createElement("span", null, t.apiInAuto)
							),
							react.createElement("p", { className: "wsp-hint" }, t.apiKeyNote)
						)
					),

					// 默认引擎
					row(
						t.defaultEngine,
						react.createElement(
							"select",
							{
								className: "wsp-select",
								value: staged.defaultEngine || "auto",
								disabled: disabled,
								onChange: (e) => set("defaultEngine", e.target.value)
							},
							ENGINE_IDS.map((id) =>
								react.createElement("option", { key: id, value: id }, id === "auto" ? t.engineAuto : id)
							)
						),
						"defaultEngine"
					),

					// 条数 / 超时
					row(
						t.maxResults,
						react.createElement("input", {
							className: "wsp-input",
							type: "number", min: 1, max: 50,
							value: staged.maxResults == null ? "" : staged.maxResults,
							disabled: disabled,
							onChange: (e) => set("maxResults", Number(e.target.value))
						}),
						"maxResults"
					),
					row(
						t.timeoutMs,
						react.createElement("input", {
							className: "wsp-input",
							type: "number", min: 3000, max: 90000, step: 500,
							value: staged.timeoutMs == null ? "" : staged.timeoutMs,
							disabled: disabled,
							onChange: (e) => set("timeoutMs", Number(e.target.value))
						}),
						"timeoutMs"
					),

					// UA
					row(
						t.userAgent,
						react.createElement("input", {
							className: "wsp-input",
							type: "text",
							style: { flex: "1", minWidth: "220px" },
							placeholder: "Mozilla/5.0 …",
							value: staged.userAgent == null ? "" : staged.userAgent,
							disabled: disabled,
							onChange: (e) => set("userAgent", e.target.value)
						}),
						"userAgent"
					),

					!writable ? react.createElement("p", { className: "wsp-status wsp-status--err" }, t.readonly) : null,
					note
						? react.createElement("p", { className: `wsp-status wsp-status--${note.kind === "ok" ? "ok" : "err"}` }, note.text)
						: null,

					// 操作区
					react.createElement(
						"div",
						{ className: "wsp-actions" },
						react.createElement("button", { className: "wsp-btn wsp-btn--primary", disabled: disabled || !dirty, onClick: save }, busy ? t.saving : t.save),
						react.createElement("button", { className: "wsp-btn", disabled: disabled || !dirty, onClick: discard }, t.discard),
						react.createElement("button", { className: "wsp-btn", disabled: disabled, onClick: resetAll }, t.reset),
						dirty ? react.createElement("span", { className: "wsp-note" }, t.dirtyHint) : null
					),

					// 测试区
					react.createElement(
						"div",
						{ className: "wsp-test" },
						react.createElement(
							"div",
							{ className: "wsp-row" },
							react.createElement("input", {
								className: "wsp-input",
								type: "text",
								style: { flex: "1", minWidth: "160px" },
								placeholder: t.testPlaceholder,
								value: staged.__testQuery == null ? "" : staged.__testQuery,
								onChange: (e) => setStaged((prev) => ({ ...prev, __testQuery: e.target.value }))
							}),
							react.createElement("button", { className: "wsp-btn", disabled: testState && testState.busy, onClick: runTest }, testState && testState.busy ? t.testing : t.test)
						),
						testState && !testState.busy && testState.data
							? react.createElement(
									"div", null,
									testState.data.error
										? react.createElement("p", { className: "wsp-status wsp-status--err" }, String(testState.data.error))
										: react.createElement(
												"div", null,
												react.createElement(
													"p", { className: testState.data.count > 0 ? "wsp-status wsp-status--ok" : "wsp-status wsp-status--err" },
													testState.data.count > 0
														? t.testOk(testState.data.engine, testState.data.count)
														: t.testFail(testState.data.engine, (testState.data.attempts || []).map((a) => `${a.engine}: ${a.error}`).join("；") || "no result")
												),
												...(testState.data.sources || []).map((src, i) =>
													react.createElement("div", { key: i },
														react.createElement("a", { href: src.url, target: "_blank", rel: "noreferrer" }, src.title || src.url),
														src.snippet ? react.createElement("span", { className: "wsp-hint" }, ` — ${String(src.snippet).slice(0, 100)}`) : null
													)
												)
											)
								)
							: null
					)
				);
			}

			function apply(ctx) {
				diag.applied = true;
				try {
					boundScope = ctx.settingsScope.bind({ namespace: NS });
				} catch (e) {
					diag.lastError = `bind: ${String((e && e.message) || e)}`;
				}

				// 注册策略：优先直接 register（本插件加载在产品模块之后，槽位
				// 规范通常已存在）；失败回退 slots.inject 等待 + 延迟重试。
				let disposeEntry = null;
				const registerOnce = (via) => {
					if (disposeEntry !== null) return true;
					try {
						const dispose = ctx.slots.register(
							{
								name: "settings.plugin.item",
								key: NS,
								inject: () => ({})
							},
							(props) => react.createElement(WebSearchCard, props)
						);
						disposeEntry = typeof dispose === "function" ? dispose : () => {};
						diag.registered = true;
						return true;
					} catch (e) {
						diag.lastError = `register(${via}): ${String((e && e.message) || e)}`;
						return false;
					}
				};

				if (registerOnce("direct")) {
					ctx.effect(() => () => {
						try { disposeEntry(); } catch { /* 静默 */ }
					}, "web-search-panel: slot entry");
				} else {
					try {
						ctx.slots.inject("settings.plugin.item", () => {
							registerOnce("inject");
							return () => {
								try { disposeEntry(); } catch { /* 静默 */ }
							};
						});
					} catch (e) {
						diag.lastError = `inject: ${String((e && e.message) || e)}`;
					}
					setTimeout(() => registerOnce("retry-1.5s"), 1500);
					setTimeout(() => registerOnce("retry-6s"), 6000);
				}
			}

			exports.apply = apply;
			exports.inject = ["slots", "settingsScope"];
		} catch (e) {
			diag.lastError = `factory: ${String((e && e.message) || e)}`;
			throw e;
		}
		return module.exports;
	}
});

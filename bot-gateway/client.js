/**
 * @file client.js
 * @description bot-gateway 的浏览器半边：把网关设置看板固化为 DSH GUI「设置」面板
 *              里的一个独立分区（settings.section 插槽）。分区内容用同源 iframe
 *              内嵌 /bot-gateway/ 看板 —— 相对路径，宿主端口漂移自动跟随。
 *
 * 加载机制：宿主侧 client-modules 扫描到 package.json 的 dsh.client 声明后，
 * 经 /plugins/bot-gateway/client.js 以经典脚本分发本文件；此处用
 * window.__ModuleLoader__.load 注册 CJS 工厂（与 dsh-plugin-console 同构）。
 * react 与 slots 服务来自 shell 静态种子表，无需 dsh.client.inject 依赖。
 *
 * 词典：中英双语（zh/en），经 locale 服务注册；设置外壳的导航文案全部由
 * 注册方提供（shell 零拷贝原则）。
 */
window.__ModuleLoader__.load({
	id: "dsh-bot-gateway",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const el = react.createElement;

		/** 词典命名空间（与插件 id 一致） */
		const NS = "bot-gateway";
		const zh = {
			"section.nav": "机器人网关",
		};
		const en = {
			"section.nav": "Bot Gateway",
		};

		/**
		 * 设置分区内容：同源内嵌看板。
		 * 高度按视口取比（设置面板是居中模态，内容列约 700px 高），
		 * iframe 自带滚动，看板内全部交互（安装/扫码/保存）可用。
		 */
		function BotGatewaySection() {
			return el("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					width: "100%",
					height: "62vh",
					minHeight: "420px",
					gap: "8px",
				},
			},
				el("iframe", {
					src: "/bot-gateway/",
					title: "DSH Bot Gateway",
					style: {
						flex: "1",
						width: "100%",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: "10px",
						background: "transparent",
					},
				}),
				el("div", {
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "flex-end",
						fontSize: "12px",
						flex: "none",
					},
				},
					el("a", {
						href: "/bot-gateway/",
						target: "_blank",
						rel: "noopener",
						style: {
							color: "var(--dsw-alias-state-business-primary)",
							textDecoration: "none",
						},
					}, "↗"),
				),
			);
		}

		/** 客户端 cordis 服务注入：slots（设置插槽）与 locale（词典） */
		const inject = ["slots", "locale"];

		/**
		 * 注册设置分区：order=5（「通用」之后、「模型」之前）。
		 * slots.inject 保证目标插槽声明上账后才注册。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "bot-gateway: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-bot-gateway",
				order: 5,
				label: () => t("section.nav"),
				locale: NS,
			}, BotGatewaySection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

import { ChevronDown, Mail } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ContactDialog } from "@/components/ContactDialog";
import { useTranslation } from "react-i18next";

const FAQ_TONE_STYLES = {
    green: {
        border: "border-green-500/20",
        accent: "text-green-400",
    },
    blue: {
        border: "border-blue-500/20",
        accent: "text-blue-400",
    },
    purple: {
        border: "border-purple-500/20",
        accent: "text-purple-400",
    },
} as const;

export default function FAQ() {
    const { i18n } = useTranslation();
    const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
    const [showContactDialog, setShowContactDialog] = useState(false);

    const toggleSection = (id: string) => {
        setOpenSections(prev => ({
            ...prev,
            [id]: !prev[id]
        }));
    };

    const lastUpdated = "October 2025";
    const isZh = i18n.language === "zh-CN";

    if (isZh) {
        const chineseSections = [
            {
                title: "1. SentiEdge 概览",
                items: [
                    {
                        id: "1.1",
                        title: "1.1 什么是 SentiEdge？",
                        content: (
                            <p className="text-muted-foreground leading-relaxed">
                                SentiEdge 是一款专为加密原生用户和交易者打造的 AI 研究与执行副驾。它将情绪分析、
                                技术指标、链上数据与实时新闻聚合在一起，为你提供更完整的加密市场洞察。无论你是日内交易者、
                                长线投资者还是研究员，都可以借助 SentiEdge 的 AI 分析更高效地做出判断。
                            </p>
                        ),
                    },
                    {
                        id: "1.2",
                        title: "1.2 SentiEdge 能帮我做什么？",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>SentiEdge 提供多维度的加密市场分析能力：</p>
                                <ul className="space-y-4">
                                    {[
                                        [
                                            "情绪分析",
                                            "按小时更新主流币种的市场情绪分数，结合社媒、新闻与市场数据帮助你识别情绪拐点。高级订阅用户还可查看最长 2 年的历史情绪数据。",
                                        ],
                                        [
                                            "链上智能",
                                            "追踪巨鲸钱包、交易所流入流出、taker 成交量、盘口深度等关键链上指标，帮助你识别潜在的大额资金动作与趋势变化。",
                                        ],
                                        [
                                            "技术分析",
                                            "支持移动均线、RSI、MACD、布林带等技术指标以及多周期价格图表，帮助你识别支撑阻力、趋势线与潜在反转信号。",
                                        ],
                                        [
                                            "新闻聚合与解读",
                                            "从可信来源汇总加密新闻，并给出情绪判断与摘要，方便你快速理解市场叙事并筛选重要事件。",
                                        ],
                                        [
                                            "市场研究与洞察",
                                            "支持对项目、代币经济学、团队背景、监管变化和市场周期等内容做深度研究，Pro 与 Enterprise 用户还可查看每周研究报告。",
                                        ],
                                        [
                                            "综合分析报告",
                                            "将情绪、技术面、链上指标、新闻和价格预测整合为一份完整报告，适合在不切换多个工具的情况下快速获取全局判断。",
                                        ],
                                        [
                                            "任务链与多资产分析",
                                            "自动执行多步骤分析流程，支持币种对比、相关性分析、组合跟踪与收藏常用任务链。",
                                        ],
                                        [
                                            "文件上传与图表分析",
                                            "支持上传图表截图、研究 PDF 或其他材料，交给 AI 做图形识别、信息提取与辅助判断。",
                                        ],
                                    ].map(([label, body]) => (
                                        <li key={label} className="flex items-start">
                                            <span className="text-blue-400 mr-2 mt-1">•</span>
                                            <div>
                                                <strong className="text-white/90">{label}：</strong>
                                                <p className="mt-1 text-sm">{body}</p>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ),
                    },
                    {
                        id: "1.3",
                        title: "1.3 SentiEdge 如何处理你的请求",
                        content: (
                            <div className="space-y-6 text-muted-foreground">
                                <p>
                                    SentiEdge 会根据问题复杂度与分析类型，在三种处理方式之间智能切换：
                                </p>
                                <div className="space-y-4">
                                    {[
                                        {
                                            color: "green",
                                            index: "1.",
                                            title: "普通消息",
                                            intro: "适合快速、单动作的直接问题。",
                                            items: [
                                                ["适用场景", "例如查看某个币种的现价、情绪分数或最近新闻。"],
                                                ["工作方式", "AI 识别最相关的一步动作并立即执行，通常几秒内返回结果。"],
                                                ["适合用途", "价格查询、单指标检查、单条新闻或单点市场信息。"],
                                            ],
                                        },
                                        {
                                            color: "blue",
                                            index: "2.",
                                            title: "任务链",
                                            intro: "适合涉及多个币种、多个步骤或多种分析方式的复杂请求。",
                                            items: [
                                                ["适用场景", "例如比较 BTC 与 ETH 的情绪、分析多个 DeFi 项目、做相关性研究。"],
                                                ["工作方式", "AI 会先生成执行计划并拆分步骤，你确认后再按顺序或并行执行。"],
                                                ["独特能力", "支持实时进度追踪、收藏任务链、随时修改或取消流程。"],
                                                ["适合用途", "多资产对比、组合分析、系统化筛选和重复性研究流程。"],
                                            ],
                                        },
                                        {
                                            color: "purple",
                                            index: "3.",
                                            title: "综合分析",
                                            intro: "适合需要一次性调取所有关键数据源的深度全景分析。",
                                            items: [
                                                ["适用场景", "例如请求某个币种的完整市场分析或全量研究报告。"],
                                                ["工作方式", "系统自动执行预定义的深度流程，同时抓取情绪、技术指标、链上数据、新闻、价格与预测结果。"],
                                                ["报告产出", "最终会整理成带图表与结论的 HTML 报告，方便复盘或分享。"],
                                                ["进度追踪", "你会看到数据采集、分析计算、报告生成三个阶段的实时进度。"],
                                                ["适合用途", "重大交易前尽调、日报周报、项目深度研究，以及你不确定该先看哪些指标的时候。"],
                                            ],
                                        },
                                    ].map((card) => (
                                        <div
                                            key={card.title}
                                            className={`p-4 rounded-lg bg-background/50 border ${
                                                FAQ_TONE_STYLES[card.color as keyof typeof FAQ_TONE_STYLES].border
                                            }`}
                                        >
                                            <h4 className="text-white/90 font-semibold mb-3 flex items-center">
                                                <span
                                                    className={`mr-2 ${
                                                        FAQ_TONE_STYLES[card.color as keyof typeof FAQ_TONE_STYLES].accent
                                                    }`}
                                                >
                                                    {card.index}
                                                </span>
                                                {card.title}
                                            </h4>
                                            <p className="text-sm mb-3">{card.intro}</p>
                                            <ul className="space-y-2 text-sm ml-4">
                                                {card.items.map(([label, body]) => (
                                                    <li key={label} className="flex items-start">
                                                        <span
                                                            className={`mr-2 ${
                                                                FAQ_TONE_STYLES[card.color as keyof typeof FAQ_TONE_STYLES].accent
                                                            }`}
                                                        >
                                                            •
                                                        </span>
                                                        <div>
                                                            <strong className="text-white/80">{label}：</strong> {body}
                                                        </div>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                    <p className="text-sm">
                                        <strong className="text-amber-400">智能路由：</strong>
                                        你无需手动选择模式。SentiEdge 会自动判断该用普通消息、任务链还是综合分析，
                                        同时始终向你展示进度与执行反馈。
                                    </p>
                                </div>
                            </div>
                        ),
                    },
                    {
                        id: "1.4",
                        title: "1.4 匿名用户与注册用户",
                        content: (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead>
                                        <tr className="border-b border-border">
                                            <th className="p-3 font-medium text-white/90">功能</th>
                                            <th className="p-3 font-medium text-white/90">匿名</th>
                                            <th className="p-3 font-medium text-white/90">注册（免费）</th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-muted-foreground">
                                        {[
                                            ["每日消息上限", "5 条消息", "更高上限"],
                                            ["会话历史", "仅当前会话", "可保存并同步"],
                                            ["基础分析", "✓", "✓"],
                                            ["任务链", "✓", "✓"],
                                            ["高级功能", "✗", "需要升级"],
                                        ].map((row) => (
                                            <tr key={row[0]} className="border-b border-border/50 last:border-0">
                                                <td className="p-3">{row[0]}</td>
                                                <td className="p-3">{row[1]}</td>
                                                <td className="p-3">{row[2]}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ),
                    },
                ],
            },
            {
                title: "2. 订阅方案",
                items: [
                    {
                        id: "2.1",
                        title: "2.1 免费版与付费版",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>SentiEdge 提供多个订阅层级，适配不同使用需求：</p>
                                <ul className="space-y-2">
                                    {[
                                        ["text-green-400", "免费版", "提供基础分析与每日消息上限。"],
                                        ["text-blue-400", "Plus", "适合活跃交易者的完整专业分析能力。"],
                                        ["text-purple-400", "Pro", "更强模型与更长历史数据。"],
                                        ["text-pink-400", "Enterprise", "支持 API 接入与定制能力。"],
                                    ].map(([color, label, body]) => (
                                        <li key={label} className="flex items-start">
                                            <span className={`${color} mr-2`}>•</span>
                                            <span><strong className="text-white/90">{label}：</strong>{body}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ),
                    },
                    {
                        id: "2.2",
                        title: "2.2 Plus 方案（$19/月 或 $179/年）",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>适合活跃交易者和加密爱好者：</p>
                                <ul className="space-y-2">
                                    {[
                                        "每小时更新情绪分数（约 5 分钟延迟）",
                                        "市场洞察与 AI 新闻摘要",
                                        "面向加密问题的专属引擎",
                                        "链上数据分析与可视化",
                                        "主流币种技术分析与图表",
                                        "主流币种价格走势预测",
                                        "综合分析报告",
                                        "邮件支持",
                                    ].map((item) => (
                                        <li key={item} className="flex items-start">
                                            <span className="text-blue-400 mr-2">✓</span>
                                            <span>{item}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ),
                    },
                    {
                        id: "2.3",
                        title: "2.3 Pro 方案（$149/月 或 $1,390/年）",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>适合需要更强分析能力的专业交易者：</p>
                                <ul className="space-y-2">
                                    {[
                                        "包含 Plus 的全部能力，并提供更高额度",
                                        "情绪分数支持最长 2 年历史数据",
                                        "更长记忆与更大上下文",
                                        "更好的 AI 模型用于问题与分析",
                                        "覆盖更多加密资产",
                                        "每周研究报告简版",
                                        "优先邮件支持",
                                    ].map((item) => (
                                        <li key={item} className="flex items-start">
                                            <span className="text-purple-400 mr-2">✓</span>
                                            <span>{item}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ),
                    },
                    {
                        id: "2.4",
                        title: "2.4 Enterprise 方案（定制报价）",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>适合机构与大型团队：</p>
                                <ul className="space-y-2">
                                    {[
                                        "包含 Pro 的全部能力并提供更多扩展",
                                        "情绪分数支持全量历史数据",
                                        "支持定制 API 接入",
                                        "完整每周研究报告",
                                        "定制 AI 模型微调与集成支持",
                                        "智能体系统功能与设计定制",
                                        "专属技术支持",
                                    ].map((item) => (
                                        <li key={item} className="flex items-start">
                                            <span className="text-pink-400 mr-2">✓</span>
                                            <span>{item}</span>
                                        </li>
                                    ))}
                                </ul>
                                <p>
                                    如需 Enterprise 报价与定制功能，请联系
                                    {" "}
                                    <a href="mailto:support@sentiedge.ai" className="text-blue-400 hover:underline">
                                        support@sentiedge.ai
                                    </a>
                                    。
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "2.5",
                        title: "2.5 如何升级或管理订阅",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>升级账户很简单：</p>
                                <ol className="space-y-3 list-decimal list-inside">
                                    <li>登录后点击顶部设置图标</li>
                                    <li>进入“支付”标签页</li>
                                    <li>选择目标方案（Plus、Pro 或 Enterprise）</li>
                                    <li>完成安全支付流程</li>
                                </ol>
                                <p>
                                    当你触发消息限制时，也可以直接从提示入口升级。按年订阅通常比按月更划算，
                                    所有支付均通过 Stripe 安全处理。
                                </p>
                            </div>
                        ),
                    },
                ],
            },
            {
                title: "3. 其他信息",
                items: [
                    {
                        id: "3.1",
                        title: "3.1 联系与支持",
                        content: (
                            <div className="space-y-3 text-muted-foreground">
                                <p>如果你需要帮助，可以通过以下方式联系我们：</p>
                                <p>
                                    <strong className="text-white/90">邮件支持：</strong>
                                    {" "}
                                    <a href="mailto:support@sentiedge.ai" className="text-blue-400 hover:underline">
                                        support@sentiedge.ai
                                    </a>
                                </p>
                                <p>
                                    <strong className="text-white/90">反馈入口：</strong>
                                    使用侧边栏中的“发送反馈”按钮报告问题或提出建议。
                                </p>
                                <p className="text-sm">
                                    响应时间：免费用户通常 48 小时内，Plus 用户 24 小时内，Pro 用户 12 小时内，
                                    Enterprise 用户享有专属支持。
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "3.2",
                        title: "3.2 数据来源与准确性",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>SentiEdge 的分析主要基于以下数据来源：</p>
                                <ul className="space-y-2">
                                    {[
                                        "实时价格数据与市场指标",
                                        "链上交易数据与区块链分析",
                                        "精选加密新闻与社交媒体情绪",
                                        "自研情绪分析数据库",
                                    ].map((item) => (
                                        <li key={item} className="flex items-start">
                                            <span className="text-blue-400 mr-2">•</span>
                                            <span>{item}</span>
                                        </li>
                                    ))}
                                </ul>
                                <p>
                                    <strong className="text-white/90">重要提示：</strong>
                                    所有数据仅供参考，不构成财务建议。做出投资决策前，请务必自行研究并咨询专业人士。
                                </p>
                            </div>
                        ),
                    },
                    {
                        id: "3.3",
                        title: "3.3 隐私与安全",
                        content: (
                            <div className="space-y-4 text-muted-foreground">
                                <p>你的隐私和安全是我们的重点：</p>
                                <ul className="space-y-2">
                                    {[
                                        "所有数据在传输和存储过程中均经过加密",
                                        "我们不会将你的数据出售给第三方",
                                        "匿名使用无需提交个人信息",
                                        "支付由 Stripe 安全处理",
                                        "你可以随时删除自己的账户与数据",
                                    ].map((item) => (
                                        <li key={item} className="flex items-start">
                                            <span className="text-green-400 mr-2">✓</span>
                                            <span>{item}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ),
                    },
                ],
            },
        ];

        return (
            <div className="min-h-screen bg-background text-foreground">
                <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
                    <div className="text-center mb-12">
                        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-4 bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                            SentiEdge 常见问题
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            最后更新：2025 年 10 月
                        </p>
                    </div>

                    {chineseSections.map((section) => (
                        <section key={section.title} className="mb-12">
                            <h2 className="text-2xl sm:text-3xl font-semibold mb-6 text-white/90">
                                {section.title}
                            </h2>

                            {section.items.map((item) => (
                                <div key={item.id} className="mb-6">
                                    <button
                                        onClick={() => toggleSection(item.id)}
                                        className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                                    >
                                        <h3 className="text-lg font-medium">{item.title}</h3>
                                        <ChevronDown
                                            className={`w-5 h-5 transition-transform ${openSections[item.id] ? 'rotate-180' : ''}`}
                                        />
                                    </button>
                                    {openSections[item.id] && (
                                        <div className="mt-4 p-4 rounded-lg bg-card/50">
                                            {item.content}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </section>
                    ))}

                    <div className="mt-16 pt-8 border-t border-border text-center">
                        <p className="text-muted-foreground text-sm mb-4">
                            还有其他问题？
                        </p>
                        <div className="flex justify-center gap-3 mb-6">
                            <Button
                                variant="outline"
                                onClick={() => setShowContactDialog(true)}
                                className="gap-2"
                            >
                                <Mail className="h-4 w-4" />
                                联系我们
                            </Button>
                        </div>
                        <p className="text-muted-foreground text-xs">
                            © 2025 SentiEdge。保留所有权利。
                        </p>
                    </div>

                    <ContactDialog
                        open={showContactDialog}
                        onOpenChange={setShowContactDialog}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background text-foreground">
            {/* Header */}
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
                <div className="text-center mb-12">
                    <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold mb-4 bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                        SentiEdge FAQ
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Last updated: {lastUpdated}
                    </p>
                </div>

                {/* Section 1: SentiEdge General */}
                <section className="mb-12">
                    <h2 className="text-2xl sm:text-3xl font-semibold mb-6 text-white/90">
                        1. SentiEdge General
                    </h2>

                    {/* 1.1 What is SentiEdge */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('1.1')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">1.1 What is SentiEdge?</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['1.1'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['1.1'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground leading-relaxed">
                                    SentiEdge is an AI research and execution copilot built specifically for crypto natives and traders.
                                    It combines advanced sentiment analysis, technical indicators, on-chain data, and real-time news
                                    aggregation to provide comprehensive cryptocurrency market insights. Whether you're a day trader,
                                    long-term investor, or crypto researcher, SentiEdge helps you make informed decisions with
                                    AI-powered analysis.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* 1.2 What can SentiEdge do for me */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('1.2')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">1.2 What can SentiEdge do for me?</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['1.2'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['1.2'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    SentiEdge provides comprehensive crypto analysis across multiple dimensions:
                                </p>
                                <ul className="space-y-4 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">Sentiment Analysis:</strong>
                                            <p className="mt-1 text-sm">
                                                Get real-time market sentiment scores for major cryptocurrencies with hourly updates.
                                                Our proprietary sentiment engine analyzes social media, news, and market data to give you
                                                a clear picture of market mood. Track sentiment trends over time to identify potential
                                                market shifts before they happen. Premium users get access to up to 2 years of historical
                                                sentiment data for deeper trend analysis.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">On-Chain Intelligence:</strong>
                                            <p className="mt-1 text-sm">
                                                Monitor whale wallet movements, exchange inflows/outflows, and key blockchain metrics in real-time.
                                                Get alerts on large transactions that could signal market moves. Track taker volume to understand
                                                buying and selling pressure. Analyze bid-ask spreads and order book depth to gauge market liquidity.
                                                Perfect for identifying accumulation patterns and potential breakouts.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">Technical Analysis:</strong>
                                            <p className="mt-1 text-sm">
                                                Access advanced technical indicators including moving averages, RSI, MACD, Bollinger Bands, and more.
                                                Get interactive price charts with multiple timeframes. Our AI analyzes chart patterns to identify
                                                support/resistance levels, trend lines, and potential reversal signals. Receive price movement
                                                predictions based on historical patterns and current market conditions.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">News Aggregation & Analysis:</strong>
                                            <p className="mt-1 text-sm">
                                                Stay updated with curated crypto news from trusted sources. Each news article is analyzed for
                                                sentiment (bullish, bearish, or neutral) so you can quickly understand market narratives.
                                                Get AI-generated summaries of long articles to save time. Filter news by cryptocurrency,
                                                time period, or sentiment to focus on what matters most to your trading strategy.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">Market Research & Insights:</strong>
                                            <p className="mt-1 text-sm">
                                                Get deep dives into crypto projects, including tokenomics, team background, technology stack,
                                                and competitive landscape. Track institutional adoption trends and regulatory developments.
                                                Understand market cycles using Fear & Greed Index analysis. Pro and Enterprise users receive
                                                weekly research reports covering market trends, emerging opportunities, and risk factors.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">Comprehensive Analysis Reports:</strong>
                                            <p className="mt-1 text-sm">
                                                Request all-in-one analysis that combines sentiment scores, technical indicators, on-chain metrics,
                                                recent news, and price predictions into a single comprehensive report. Perfect for making informed
                                                trading decisions without jumping between multiple tools. Reports are generated in real-time with
                                                progress tracking so you see exactly what data is being analyzed. Export reports for offline review
                                                or sharing with your team.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">Task Chains & Multi-Asset Analysis:</strong>
                                            <p className="mt-1 text-sm">
                                                Execute complex multi-step analysis workflows automatically. Compare multiple cryptocurrencies
                                                side-by-side, analyze correlations, or track portfolio performance. Save your favorite task chains
                                                for quick reuse. Perfect for systematic analysis routines or screening multiple assets efficiently.
                                                Watch each step execute in real-time with full transparency.
                                            </p>
                                        </div>
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2 mt-1">•</span>
                                        <div>
                                            <strong className="text-white/90">File Upload & Chart Analysis:</strong>
                                            <p className="mt-1 text-sm">
                                                Upload images of charts, screenshots of trading setups, or PDF reports for AI-powered analysis.
                                                Get instant insights on chart patterns, technical indicators visible in your images, and key
                                                information extraction from documents. Perfect for getting a second opinion on your analysis
                                                or understanding complex technical setups.
                                            </p>
                                        </div>
                                    </li>
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* 1.3 Technical Capabilities */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('1.3')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">1.3 How SentiEdge Processes Your Requests</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['1.3'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['1.3'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-6">
                                    SentiEdge intelligently routes your requests through three different processing methods based on
                                    the complexity and type of analysis needed:
                                </p>

                                {/* Regular Message */}
                                <div className="mb-6 p-4 rounded-lg bg-background/50 border border-green-500/20">
                                    <h4 className="text-white/90 font-semibold mb-3 flex items-center">
                                        <span className="text-green-400 mr-2">1.</span>
                                        Regular Message
                                    </h4>
                                    <p className="text-muted-foreground text-sm mb-3">
                                        Fast, single-action analysis for straightforward questions:
                                    </p>
                                    <ul className="space-y-2 text-sm text-muted-foreground ml-4">
                                        <li className="flex items-start">
                                            <span className="text-green-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">When it's used:</strong> For simple, focused queries about
                                                a single cryptocurrency or specific data point. Examples: "What's Bitcoin's current price?",
                                                "Show me Ethereum's sentiment score", "What's the latest news on Solana?"
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-green-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">How it works:</strong> The AI analyzes your question,
                                                identifies the single most relevant action (check price, get sentiment, fetch news, etc.),
                                                executes it immediately, and returns results in seconds. No multi-step planning needed.
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-green-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">Best for:</strong> Quick price checks, sentiment lookups,
                                                news updates, single technical indicator checks, or any question that requires one specific
                                                piece of information. Fastest response time.
                                            </div>
                                        </li>
                                    </ul>
                                </div>

                                {/* Task Chain */}
                                <div className="mb-6 p-4 rounded-lg bg-background/50 border border-blue-500/20">
                                    <h4 className="text-white/90 font-semibold mb-3 flex items-center">
                                        <span className="text-blue-400 mr-2">2.</span>
                                        Task Chain
                                    </h4>
                                    <p className="text-muted-foreground text-sm mb-3">
                                        Multi-step workflow execution for complex analysis requests:
                                    </p>
                                    <ul className="space-y-2 text-sm text-muted-foreground ml-4">
                                        <li className="flex items-start">
                                            <span className="text-blue-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">When it's used:</strong> For requests involving multiple
                                                cryptocurrencies, comparisons, or requiring several different types of analysis. Examples:
                                                "Compare Bitcoin and Ethereum sentiment", "Analyze the top 5 DeFi tokens", "Show me correlation
                                                between BTC price and market sentiment over the last month".
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-blue-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">How it works:</strong> The AI first creates a detailed execution
                                                plan breaking down your request into logical steps. You see and approve this plan before execution
                                                starts. Each step runs sequentially or in parallel (when possible), with real-time progress tracking.
                                                Results from earlier steps can inform later steps for intelligent dependency resolution.
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-blue-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">Unique features:</strong> Save favorite task chains for reuse,
                                                watch each step execute in real-time, see exactly which data is being gathered at each stage.
                                                You can modify or cancel the workflow at any point. Perfect for repeated analysis routines or
                                                systematic screening processes.
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-blue-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">Best for:</strong> Multi-asset comparisons, portfolio analysis,
                                                correlation studies, systematic screening, or any request requiring 2-5 distinct analysis steps.
                                                Provides full transparency into the analysis process.
                                            </div>
                                        </li>
                                    </ul>
                                </div>

                                {/* Comprehensive Analysis */}
                                <div className="mb-4 p-4 rounded-lg bg-background/50 border border-purple-500/20">
                                    <h4 className="text-white/90 font-semibold mb-3 flex items-center">
                                        <span className="text-purple-400 mr-2">3.</span>
                                        Comprehensive Analysis
                                    </h4>
                                    <p className="text-muted-foreground text-sm mb-3">
                                        All-in-one deep dive analysis combining every available data source:
                                    </p>
                                    <ul className="space-y-2 text-sm text-muted-foreground ml-4">
                                        <li className="flex items-start">
                                            <span className="text-purple-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">When it's used:</strong> When you request a complete market
                                                overview or comprehensive analysis of a cryptocurrency. Examples: "Give me a comprehensive analysis
                                                of Bitcoin", "Full market report on Ethereum", "Complete analysis of Cardano including all metrics".
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-purple-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">How it works:</strong> Automatically executes a pre-defined
                                                comprehensive workflow that gathers ALL available data types: sentiment scores (with historical trends),
                                                technical indicators (20+ indicators), on-chain metrics (whale movements, exchange flows), recent news
                                                (with sentiment analysis), price data, Fear & Greed Index, and price predictions. All analysis runs
                                                in parallel phases for maximum efficiency.
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-purple-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">Report generation:</strong> Results are compiled into a structured
                                                HTML report with interactive charts, data tables, and AI-generated insights. The report synthesizes
                                                all gathered data into actionable trading insights, highlighting key opportunities and risks. Reports
                                                can be exported and saved for later reference.
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-purple-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">Progress tracking:</strong> Watch the analysis unfold in three
                                                phases: (1) Data Gathering - collecting all metrics from various sources, (2) Analysis - processing
                                                and computing insights, (3) Report Generation - compiling everything into your final report. Each
                                                phase shows detailed progress so you know exactly what's happening.
                                            </div>
                                        </li>
                                        <li className="flex items-start">
                                            <span className="text-purple-400 mr-2">•</span>
                                            <div>
                                                <strong className="text-white/80">Best for:</strong> In-depth due diligence before major trades,
                                                daily/weekly market reviews, comprehensive project research, or when you need the complete picture
                                                without knowing exactly which specific metrics to request. Most thorough analysis option.
                                            </div>
                                        </li>
                                    </ul>
                                </div>

                                <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                                    <p className="text-sm text-muted-foreground">
                                        <strong className="text-amber-400">Intelligent Routing:</strong> You don't need to choose which method to use—
                                        SentiEdge's AI automatically determines the best approach based on your question. Simple queries use Regular Messages
                                        for speed, complex multi-step requests trigger Task Chains for transparency, and comprehensive analysis requests
                                        activate the full deep-dive workflow. All three methods provide real-time feedback so you always know what's happening.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 1.4 User Types */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('1.4')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">1.4 Anonymous vs. Registered Users</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['1.4'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['1.4'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left text-sm">
                                        <thead>
                                            <tr className="border-b border-border">
                                                <th className="p-3 font-medium text-white/90">Feature</th>
                                                <th className="p-3 font-medium text-white/90">Anonymous</th>
                                                <th className="p-3 font-medium text-white/90">Registered (Free)</th>
                                            </tr>
                                        </thead>
                                        <tbody className="text-muted-foreground">
                                            <tr className="border-b border-border/50">
                                                <td className="p-3">Daily Message Limit</td>
                                                <td className="p-3">5 messages</td>
                                                <td className="p-3">Higher limits</td>
                                            </tr>
                                            <tr className="border-b border-border/50">
                                                <td className="p-3">Conversation History</td>
                                                <td className="p-3">Session only</td>
                                                <td className="p-3">Saved & synced</td>
                                            </tr>
                                            <tr className="border-b border-border/50">
                                                <td className="p-3">Basic Analysis</td>
                                                <td className="p-3">✓</td>
                                                <td className="p-3">✓</td>
                                            </tr>
                                            <tr className="border-b border-border/50">
                                                <td className="p-3">Task Chains</td>
                                                <td className="p-3">✓</td>
                                                <td className="p-3">✓</td>
                                            </tr>
                                            <tr>
                                                <td className="p-3">Premium Features</td>
                                                <td className="p-3">✗</td>
                                                <td className="p-3">Upgrade required</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                </section>

                {/* Section 2: Subscription */}
                <section className="mb-12">
                    <h2 className="text-2xl sm:text-3xl font-semibold mb-6 text-white/90">
                        2. Subscription Plans
                    </h2>

                    {/* 2.1 Free vs Paid */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('2.1')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">2.1 Free vs. Paid Plans</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['2.1'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['2.1'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    SentiEdge offers multiple tiers to match your needs:
                                </p>
                                <ul className="space-y-2 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-green-400 mr-2">•</span>
                                        <strong className="text-white/90">Free:</strong> Basic analysis with daily message limits
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">•</span>
                                        <strong className="text-white/90">Plus:</strong> Full-featured professional analysis
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">•</span>
                                        <strong className="text-white/90">Pro:</strong> Advanced models with historical data
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">•</span>
                                        <strong className="text-white/90">Enterprise:</strong> Custom solutions with API access
                                    </li>
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* 2.2 Plus Plan */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('2.2')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">2.2 Plus Plan ($19/month or $179/year)</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['2.2'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['2.2'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    Perfect for active traders and crypto enthusiasts:
                                </p>
                                <ul className="space-y-2 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Hourly sentiment score updates (~5 minutes latency)
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Market insights & AI news briefs
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Dedicated engine for crypto questions
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Comprehensive on-chain data analysis and visualization
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Technical analysis on main cryptos with visualization
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Price movement prediction on main cryptos
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Comprehensive analysis reports
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">✓</span>
                                        Email support
                                    </li>
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* 2.3 Pro Plan */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('2.3')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">2.3 Pro Plan ($149/month or $1,390/year)</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['2.3'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['2.3'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    For professional traders who need the best tools:
                                </p>
                                <ul className="space-y-2 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        Everything in Plus with even higher limits
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        Hourly sentiment score updates with up to 2 years of historical data
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        Longer memory and context
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        Better AI models for all questions and analysis
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        More tracked cryptocurrencies
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        Weekly research report brief on cryptos
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-purple-400 mr-2">✓</span>
                                        Priority email support
                                    </li>
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* 2.4 Enterprise Plan */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('2.4')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">2.4 Enterprise Plan (Custom Pricing)</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['2.4'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['2.4'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    Custom solutions for institutions and large teams:
                                </p>
                                <ul className="space-y-2 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Everything in Pro and more
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Hourly sentiment score updates with all historical data
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Custom API access for integration
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Full weekly research reports on cryptos
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Custom AI model fine-tuning & integration support
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Custom functionalities and design for agent system
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-pink-400 mr-2">✓</span>
                                        Dedicated technical support
                                    </li>
                                </ul>
                                <p className="text-muted-foreground mt-4">
                                    Contact us at{' '}
                                    <a href="mailto:support@sentiedge.ai" className="text-blue-400 hover:underline">
                                        support@sentiedge.ai
                                    </a>
                                    {' '}for Enterprise pricing and custom features.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* 2.5 How to Upgrade */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('2.5')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">2.5 How to Upgrade or Manage Subscription</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['2.5'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['2.5'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    Upgrading your account is simple:
                                </p>
                                <ol className="space-y-3 text-muted-foreground list-decimal list-inside">
                                    <li>Click the settings icon in the header (when logged in)</li>
                                    <li>Navigate to the "Payment" tab</li>
                                    <li>Select your desired plan (Plus, Pro, or Enterprise)</li>
                                    <li>Complete the secure checkout process</li>
                                </ol>
                                <p className="text-muted-foreground mt-4">
                                    You can also upgrade directly when prompted about message limits. Annual billing
                                    saves you money compared to monthly plans. All payments are processed securely
                                    through Stripe.
                                </p>
                            </div>
                        )}
                    </div>
                </section>

                {/* Section 3: Other Information */}
                <section className="mb-12">
                    <h2 className="text-2xl sm:text-3xl font-semibold mb-6 text-white/90">
                        3. Other Information
                    </h2>

                    {/* 3.1 Support */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('3.1')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">3.1 Contact & Support</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['3.1'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['3.1'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    We're here to help! Reach out to us through:
                                </p>
                                <div className="space-y-3 text-muted-foreground">
                                    <p>
                                        <strong className="text-white/90">Email Support:</strong>{' '}
                                        <a href="mailto:support@sentiedge.ai" className="text-blue-400 hover:underline">
                                            support@sentiedge.ai
                                        </a>
                                    </p>
                                    <p>
                                        <strong className="text-white/90">Feedback:</strong> Use the "Send Feedback" button
                                        in the sidebar to report bugs or suggest improvements
                                    </p>
                                    <p className="text-sm">
                                        Response times: Free users within 48 hours, Plus users within 24 hours,
                                        Pro users within 12 hours, Enterprise clients have dedicated support.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 3.2 Data Sources */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('3.2')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">3.2 Data Sources & Accuracy</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['3.2'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['3.2'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    SentiEdge provides comprehensive analysis using:
                                </p>
                                <ul className="space-y-2 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">•</span>
                                        Real-time price data and market metrics
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">•</span>
                                        On-chain transaction data and blockchain analytics
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">•</span>
                                        Curated crypto news and social media sentiment
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-blue-400 mr-2">•</span>
                                        Proprietary sentiment analysis database
                                    </li>
                                </ul>
                                <p className="text-muted-foreground mt-4">
                                    <strong className="text-white/90">Important:</strong> All data is provided for
                                    informational purposes only. SentiEdge does not provide financial advice. Always
                                    do your own research and consult with financial professionals before making
                                    investment decisions.
                                </p>
                            </div>
                        )}
                    </div>

                    {/* 3.3 Privacy & Security */}
                    <div className="mb-6">
                        <button
                            onClick={() => toggleSection('3.3')}
                            className="flex items-center justify-between w-full text-left p-4 rounded-lg bg-card hover:bg-card/80 transition-colors"
                        >
                            <h3 className="text-lg font-medium">3.3 Privacy & Security</h3>
                            <ChevronDown
                                className={`w-5 h-5 transition-transform ${openSections['3.3'] ? 'rotate-180' : ''}`}
                            />
                        </button>
                        {openSections['3.3'] && (
                            <div className="mt-4 p-4 rounded-lg bg-card/50">
                                <p className="text-muted-foreground mb-4">
                                    Your privacy and security are our top priorities:
                                </p>
                                <ul className="space-y-2 text-muted-foreground">
                                    <li className="flex items-start">
                                        <span className="text-green-400 mr-2">✓</span>
                                        All data is encrypted in transit and at rest
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-green-400 mr-2">✓</span>
                                        We never sell your data to third parties
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-green-400 mr-2">✓</span>
                                        Anonymous usage doesn't require any personal information
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-green-400 mr-2">✓</span>
                                        Payment processing handled securely through Stripe
                                    </li>
                                    <li className="flex items-start">
                                        <span className="text-green-400 mr-2">✓</span>
                                        You can delete your account and data at any time
                                    </li>
                                </ul>
                            </div>
                        )}
                    </div>
                </section>

                {/* Footer */}
                <div className="mt-16 pt-8 border-t border-border text-center">
                    <p className="text-muted-foreground text-sm mb-4">
                        Still have questions?
                    </p>
                    <div className="flex justify-center gap-3 mb-6">
                        <Button
                            variant="outline"
                            onClick={() => setShowContactDialog(true)}
                            className="gap-2"
                        >
                            <Mail className="h-4 w-4" />
                            Contact with Group
                        </Button>
                    </div>
                    <p className="text-muted-foreground text-xs">
                        © 2025 SentiEdge. All rights reserved.
                    </p>
                </div>

                {/* Contact Dialog */}
                <ContactDialog
                    open={showContactDialog}
                    onOpenChange={setShowContactDialog}
                />
            </div>
        </div>
    );
}

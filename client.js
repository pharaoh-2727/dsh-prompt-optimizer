/**
 * dsh-prompt-optimizer —— Client 半区（DSH 专用版）
 *
 * 五个界面 + 一个快捷键：
 *   1. `conversation.input.right`：发送键左侧的「优化」按钮。
 *   2. `conversation.input.dock`：输入框上方的预览卡，结果先在这里，确认才写回。
 *   3. `conversation.session.header.actions`：会话标题旁的「优化」，手在标题栏附近时用。
 *   4. `settings.section`：设置里的「优化」一页，配置模型与提示词风格。
 *   5. `shell.overlay`：免费通道的提示弹层。
 *   + Alt+O：全局快捷键，等同于点「优化」/「替换草稿」。
 *
 * 斜杠命令 `/optimize` 的实现在宿主半区；这里只给它挂一个「裸调用」装饰，
 * 让 /optimize 不带参数时也能触发本页的动作（带参数时仍然走宿主的命令本体）。
 *
 * 视觉规范：高度 28px、无边框、hover 用 interactive-bg-hover，
 * 图标用内联 SVG（不用 emoji —— 跨系统渲染差异大且与 UI 风格不符）。
 *
 * 读写输入框的两个接口来自 slot 的 standardProps：
 *   - `useInput(selector => ...)` 读 InputState.draft
 *   - `inputActions.setDraft(text)` 整体替换草稿
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    // ── 样式 ──────────────────────────────────────────────────────────────

    const BUTTON_CSS = `
.dsho-root{position:relative;display:inline-flex;align-items:center;flex:none}
.dsho-btn{
  appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;
  height:28px;padding:0 9px;
  border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;
  color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;font-weight:500;line-height:20px;
  cursor:pointer;white-space:nowrap;
  transition:background-color .1s,color .1s,opacity .1s;
}
.dsho-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsho-btn:disabled{opacity:.4;cursor:default}
.dsho-btn[data-busy="true"]{color:var(--dsw-alias-state-business-primary);opacity:1}
/* 退回态：图标用品牌蓝，和「优化」的双星区分开 */
.dsho-btn[data-mode="restore"] .dsho-icon{color:var(--dsw-alias-brand-primary)}
.dsho-icon{display:block;flex:none;width:14px;height:14px}
.dsho-spin{animation:dsho-rotate .9s linear infinite;transform-origin:50% 50%}
@keyframes dsho-rotate{to{transform:rotate(360deg)}}
.dsho-err{
  position:absolute;bottom:calc(100% + 8px);right:0;
  width:max-content;max-width:260px;
  padding:7px 10px;
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-state-error-primary);
  font-size:12px;line-height:17px;
  box-shadow:var(--dsw-elevation-soft);
  z-index:70;
  word-break:break-word;
}
/* 取消态：运行中的按钮点一下就中止这次优化，用错误色提示「这是个停止键」 */
.dsho-btn[data-mode="cancel"] .dsho-icon{color:var(--dsw-alias-state-error-primary)}
`

    /**
     * 会话头按钮样式（conversation.session.header.actions）。
     *
     * 标题栏里只放图标：那里已经有标题、任务列表、子代理等一堆东西，
     * 再加两个字会把标题挤掉。28px 见方，和宿主自己的会话头按钮同高。
     */
    const HEAD_CSS = `
.dsho-head-root{position:relative;display:inline-flex;align-items:center;flex:none}
.dsho-head-btn{
  appearance:none;display:inline-flex;align-items:center;justify-content:center;
  position:relative;width:28px;height:28px;padding:0;
  border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;transition:background-color .1s,color .1s,opacity .1s;
}
.dsho-head-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsho-head-btn:disabled{opacity:.4;cursor:default}
.dsho-head-btn[data-state="running"]{color:var(--dsw-alias-state-business-primary);opacity:1}
/* 有结果等着采用：右上角一颗小圆点，不占地方但一眼能看见 */
.dsho-head-dot{
  position:absolute;top:4px;right:4px;
  width:6px;height:6px;border-radius:50%;
  background:var(--dsw-alias-brand-primary);
}
`

    /**
     * 预览卡样式（conversation.input.dock）。
     *
     * 位置在输入框卡片的上方、整条宽度，所以按卡片配方做：
     * bg-layer-2 + border-l1 + radius-panel 级别的圆角 + elevation-soft。
     * 正文用等宽偏窄的字号 —— 提示词正文是长段落，要能一眼扫完。
     *
     * 结果区是**整张预览卡的一部分**，卡片本身就是一个可缩放的窗口：
     *   - 位置固定 —— 它是普通文档流里的一个块，卡片插在哪个槽位它就在哪，
     *     没有任何「拖到别处去」的交互（想改内容请用「重新优化」或「替换草稿」）。
     *   - 整体尺寸可调 —— 手柄都长在**卡片的外沿**上：
     *       · 左、右两条竖直手柄 → 调整张卡片的宽度，各自独立：
     *         往里拖把卡片收窄，往外拖把卡片拉宽（上限取视口剩余空间，
     *         最多再各扩出 240px；拖到屏幕边上就停，不会把界面撑出横向滚动条）。
     *         左边拖动不影响右边，右边拖动也不影响左边。
     *       · 顶部一条横向手柄 → 调整张卡片的高度：往上拖变高，往下拖变矮；
     *         也可以聚焦手柄后用上下方向键微调。高度会记住，下次打开还是这个大小。
     *   - 手柄平时**藏起来** —— 默认透明看不见，鼠标移到卡片上（或正在拖动、
     *     键盘聚焦）才显现，避免界面上一堆常驻的把手，看着乱。
     */
    const PREVIEW_CSS = `
.dsho-dock{
  position:relative;
  width:100%;
  display:flex;
  flex-direction:column;
  gap:8px;
  padding:12px 14px;
  box-sizing:border-box;
  border-radius:var(--dsw-radius-panel,16px);
  border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-elevation-soft);
  color:var(--dsw-alias-label-primary);
}
.dsho-dock-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsho-dock-title{font-size:13px;font-weight:600;line-height:20px}
.dsho-dock-meta{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsho-dock-frame{position:relative}
.dsho-dock-body{
  font-size:12px;line-height:19px;
  white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow-y:auto;
  padding:9px 11px;
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);
}
/* 用户拖过之后高度由内联样式决定，max-height 让位。 */
.dsho-dock-frame[data-resized="true"] .dsho-dock-body{max-height:none}
/*
 * 整张卡片的高度可调：高度定下来之后，正文区作为 flex 子项自动占满剩余空间，
 * 内容多了就在正文区内部滚动，头尾（标题/动作按钮）始终可见。
 */
.dsho-dock[data-height-adjusted="true"] .dsho-dock-frame{
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column;
}
.dsho-dock[data-height-adjusted="true"] .dsho-dock-body{
  max-height:none;flex:1 1 auto;min-height:0;
}
/*
 * 卡片高度一旦定死，里面每一块都得能被压缩。
 *
 * 否则「标题 + 用量 + 提示 + 按钮」这些内容驱动的固定块加起来一旦超过卡片高度，
 * 只有正文区有 min-height:0，它会先被挤成 0 高，剩下的块继续往下长 ——
 * 从卡片下沿溢出去，正好压在下面的输入框上。
 *
 * 所以：头/用量/按钮不参与压缩（flex:none，保持内容高度）——
 * 它们是这一屏的「骨头」，压掉就找不到操作了；
 * 横幅、冲突提示、思考过程、正文参与压缩（min-height:0 才能真正缩到比内容还小，
 * 缩下来的部分各自在内部滚动，或直接截断）。
 *
 * 横幅和冲突提示必须能压：它们都是**三五行的说明文字**，
 * 卡片被拖到最矮（160px）时，光「标题 + 横幅 + 提示 + 用量 + 按钮」就能顶满整张卡，
 * 正文被挤成 0 高之后继续往外长 —— 正好压在下面输入框上。
 * 真压到那个份上，用户要的也不是读提示，是看见结果。
 */
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-head,
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-usage,
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-actions{flex:none}
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-banner,
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-warn,
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-reasoning{
  flex:0 1 auto;min-height:0;overflow:hidden;
}
.dsho-dock[data-height-adjusted="true"] .dsho-dock-reasoning-body{
  flex:1 1 auto;min-height:0;
}
/*
 * 历史列表：定高之后**浮起来**，不再和正文抢空间。
 *
 * 卡片没定高时（默认）它是普通的一行块，卡片跟着长高，怎么都放得下。
 * 但卡片一旦被定死高度，它就是最尴尬的那块：
 * 内容多时要长到 180px，而正文是唯一能被压到 0 的块 ——
 * 历史一多，正文就只剩一行，用户点开「历史」反而看不见要比的结果。
 *
 * 所以定高时把它改成盖在卡片内部的下拉层：占的是正文本来的位置，
 * 正文一点不少。高度按卡片高度封顶，永远不越过底部按钮（8px 间隔 + 28px 按钮 + 12px 内边距）。
 * 12px/14px 是卡片的内边距，41px = 12(上内边距) + 21(标题行) + 8(间隙)。
 */
.dsho-dock[data-height-adjusted="true"] > .dsho-dock-history{
  position:absolute;z-index:6;left:14px;right:14px;top:41px;
  box-sizing:border-box;max-height:calc(100% - 97px);
  box-shadow:0 10px 28px rgba(0,0,0,.45);
}
/*
 * 定高之后标题行**不许折行**。
 *
 * 41px 这个偏移是按「12 内边距 + 21 标题行 + 8 间隙」算死的：
 * 模型名、档位、过程标签一多，标题行原本会折成两行（21px → 48px），
 * 浮层就压到第二行字上。定高时改成单行、超出的模型信息用省略号截断 ——
 * 那一行本来就是「这版是什么」的注脚，截断比压字可接受。
 */
.dsho-dock[data-height-adjusted="true"] .dsho-dock-head{flex-wrap:nowrap}
/* 标题和「历史 N」按钮一个字都不许折：它们是这一行的骨头，只能被截断的注脚让路。 */
.dsho-dock[data-height-adjusted="true"] .dsho-dock-head > .dsho-dock-title,
.dsho-dock[data-height-adjusted="true"] .dsho-dock-head > .dsho-dock-history-btn{
  flex:none;white-space:nowrap;
}
.dsho-dock[data-height-adjusted="true"] .dsho-dock-head > .dsho-dock-meta{
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/*
 * 宽度可调：卡片左右各一条边缘手柄。
 * 左右手柄都只改宽度，不改位置；互相独立（拖左边不影响右边界）。
 * 宽度由外层卡片的内联样式给出（width + 左右 margin），这里只声明盒模型。
 */
.dsho-dock-edge{
  position:absolute;top:0;bottom:0;
  width:10px;
  display:flex;align-items:center;justify-content:center;
  box-sizing:border-box;
  cursor:ew-resize;
  touch-action:none;
  user-select:none;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  background:transparent;
  transition:background-color .12s,color .12s;
}
.dsho-dock-edge[data-side="left"]{left:0;border-right:1px solid transparent}
/* 右边缘上下贯通。 */
.dsho-dock-edge[data-side="right"]{right:0;border-left:1px solid transparent}
.dsho-dock-edge:hover,.dsho-dock-edge:focus-visible{
  color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-interactive-bg-hover);
  outline:none;
}
.dsho-dock-edge-icon{width:8px;height:14px;display:block}
/* 高度手柄：卡片**上沿**的一条横条（浮在卡片上方的空隙里）。 */
.dsho-dock-grip{
  position:absolute;
  top:-9px;left:50%;
  transform:translateX(-50%);
  width:72px;height:18px;
  display:flex;align-items:center;justify-content:center;
  box-sizing:border-box;
  border-radius:var(--dsw-radius-sm);
  cursor:ns-resize;
  touch-action:none;
  user-select:none;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  background:transparent;
  transition:background-color .12s,color .12s;
}
.dsho-dock-grip:hover,.dsho-dock-grip:focus-visible{
  color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-interactive-bg-hover);
  outline:none;
}
.dsho-dock-grip-icon{width:14px;height:12px;display:block}
/*
 * 手柄平时藏起来：默认透明，鼠标移到卡片上、正在拖动、或者键盘聚焦时才显现。
 * 这样界面不会一直挂着三个把手，看着干净。
 */
.dsho-dock-edge,.dsho-dock-grip{opacity:0}
.dsho-dock:hover .dsho-dock-edge,
.dsho-dock:hover .dsho-dock-grip,
.dsho-dock:focus-within .dsho-dock-edge,
.dsho-dock:focus-within .dsho-dock-grip,
.dsho-dock[data-resizing="true"] .dsho-dock-edge,
.dsho-dock[data-resizing="true"] .dsho-dock-grip,
.dsho-dock-edge:focus-visible,
.dsho-dock-grip:focus-visible{opacity:1}
.dsho-dock-warn{
  font-size:12px;line-height:18px;
  color:var(--dsw-alias-state-warn-primary);
}
/*
 * 用量行：模型、档位之外，再补一句「这次花了多久、多少字、多少 token」。
 * 拿不到的数字不写 0，写「未提供」。
 */
.dsho-dock-usage{
  font-size:11px;line-height:17px;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
}
/* 思考过程：模型给了才显示，单独一小块，不跟正文混在一起。 */
.dsho-dock-reasoning{
  display:flex;flex-direction:column;gap:4px;
  padding:8px 10px;
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);
}
.dsho-dock-reasoning-title{
  font-size:11px;line-height:16px;font-weight:500;
  color:var(--dsw-alias-label-secondary);
}
.dsho-dock-reasoning-body{
  font-size:11px;line-height:17px;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  white-space:pre-wrap;word-break:break-word;
  max-height:120px;overflow-y:auto;
}
/*
 * 历史版本。
 *
 * 每次优化都留一版，列表放在标题下面、正文上面：
 *   - 默认收起，只留标题行一个「历史 N」按钮，不占地方；
 *   - 展开后最多占 180px，里面自己滚动。
 *
 * 卡片**没定高**时它是普通的一行块，卡片跟着长高，怎么都放得下；
 * 卡片一旦定死高度，就改成绝对定位的浮层（见下方 data-height-adjusted 规则）：
 * 它按内容能长到 180px，而正文是唯一能被压到 0 的块 ——
 * 留着占位的话，历史一多正文就只剩一行，用户点开「历史」反而看不见要比的结果。
 */
.dsho-dock-history-btn{
  appearance:none;margin-left:auto;
  display:inline-flex;align-items:center;gap:4px;
  height:20px;padding:0 7px;
  border-radius:999px;border:1px solid var(--dsw-alias-border-l2);
  background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:11px;line-height:18px;
  cursor:pointer;white-space:nowrap;
  transition:background-color .1s,color .1s;
}
.dsho-dock-history-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsho-dock-history-btn[data-open="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsho-dock-history{
  flex:0 1 auto;min-height:0;max-height:180px;overflow-y:auto;
  display:flex;flex-direction:column;gap:4px;
  padding:6px;
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l1);
}
.dsho-dock-history-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:0 2px 4px;
  font-size:10px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
}
.dsho-dock-history-empty{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));padding:2px 4px}
.dsho-dock-history-row{
  display:flex;align-items:center;gap:6px;
  padding:4px 6px;border-radius:6px;
  cursor:pointer;
  border:1px solid transparent;
  transition:background-color .1s,border-color .1s;
}
.dsho-dock-history-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsho-dock-history-row[data-current="true"]{border-color:var(--dsw-alias-brand-primary)}
.dsho-dock-history-time{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsho-dock-history-tag{flex:none;font-size:10px;line-height:16px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
/* 过程标签用弱一点的底色区分，不要和档位标签抢注意力。 */
.dsho-dock-history-tag[data-kind="adjust"]{border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
.dsho-dock-history-tag[data-kind="recover"]{border-style:dashed}
.dsho-dock-history-tag[data-kind="free"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsho-dock-history-text{flex:1 1 auto;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsho-dock-history-act{
  flex:none;appearance:none;border:0;background:transparent;
  padding:0 4px;height:18px;border-radius:4px;
  font:inherit;font-size:11px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));
  cursor:pointer;
}
.dsho-dock-history-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsho-dock-history-act[data-active="true"]{color:var(--dsw-alias-brand-primary)}
.dsho-dock-history-act[data-danger="true"]:hover{color:var(--dsw-alias-state-error-primary)}
/* 看历史 / 对比时的横幅：明确告诉用户「现在看的不是刚生成的那一版」。 */
.dsho-dock-banner{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  font-size:11px;line-height:17px;
  color:var(--dsw-alias-label-secondary);
  padding:5px 9px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  border:1px dashed var(--dsw-alias-border-l2);
}
.dsho-dock-banner-text{flex:1 1 auto;min-width:0}
.dsho-dock-banner-act{
  flex:none;appearance:none;border:0;background:transparent;
  padding:0 6px;height:20px;border-radius:999px;
  font:inherit;font-size:11px;line-height:20px;
  color:var(--dsw-alias-brand-primary);cursor:pointer;
}
.dsho-dock-banner-act:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* 两版并排对比。列宽各占一半，行高一致，改动的行整行标色。 */
.dsho-dock-compare{display:flex;gap:8px;min-height:0;flex:1 1 auto}
.dsho-dock-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0}
.dsho-dock-col-title{
  flex:none;font-size:10px;line-height:16px;margin-bottom:3px;
  color:var(--dsw-alias-label-secondary);
}
.dsho-dock-col-body{
  flex:1 1 auto;min-height:0;overflow:auto;
  font-size:12px;line-height:19px;
  white-space:pre-wrap;word-break:break-word;
  padding:9px 11px;
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);
}
/*
 * 每行统一留出 6px：竖条画在行盒左边缘（inset box-shadow），
 * 不留白的话第一个字会和竖条叠在一起，看起来像被底色切掉半边。
 * 未改动的行留同样的缩进，两栏、改动/未改动之间才对齐。
 *
 * box-sizing:border-box 是给「逐行等高」用的：脚本会把同一对行的行盒
 * 高度都写死成两边较高的那个。行盒得把 padding 算进这个高度里，
 * 否则写的 19px 加上内边距会把下面的行顶下去，对齐又白做了。
 */
.dsho-diff-line{padding-left:6px;box-sizing:border-box}
/* 只改了一侧的行：整行底色 + 左侧竖条，一眼能看出是「这句被换了」。 */
.dsho-diff-line[data-changed="true"]{
  background:rgba(77,107,254,.10);
  box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);
}
.dsho-diff-line[data-changed="true"][data-side="left"]{
  background:rgba(217,48,37,.09);
  box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary);
}
/*
 * 占位行：对面那一侧被删/被加，这一侧空出来保持行号对齐。
 * 只占高度，不染色、不画竖条 —— 否则两栏之间会多出一条莫名其妙的空色带。
 *
 * 选择器必须和上面两条染色规则一样长（含 data-side），否则特异性输了：
 * 占位行本身也带 data-changed="true"，[data-changed][data-side="left"]
 * 是 3 个权重，只用 [data-filler] 的 2 个权重压不住，左栏会出现整块红底。
 */
.dsho-diff-line[data-filler="true"],
.dsho-diff-line[data-changed="true"][data-side="left"][data-filler="true"],
.dsho-diff-line[data-changed="true"][data-side="right"][data-filler="true"]{
  background:transparent;
  box-shadow:none;
}
.dsho-dock-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsho-dock-btn{
  appearance:none;
  height:28px;padding:0 12px;
  border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);
  background:transparent;
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-weight:500;
  cursor:pointer;
  transition:background-color .1s,border-color .1s,color .1s,opacity .1s;
}
.dsho-dock-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsho-dock-btn:disabled{opacity:.45;cursor:default}
/* 已处于对比态：用一个描边强调，和「退出对比」是同一个按钮的两种状态。 */
.dsho-dock-btn[data-active="true"]{
  border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-brand-primary);
}
.dsho-dock-btn[data-primary="true"]{
  border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground,#fff);
}
.dsho-dock-btn[data-primary="true"]:hover:not(:disabled){
  background:var(--dsw-alias-button-primary-fill-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));
}
`

    const PAGE_CSS = `
.dsho-page{display:flex;flex-direction:column;gap:22px;padding:2px 0 10px;width:100%}

/*
 * 区块标题：左侧一条品牌蓝竖线。
 * 整页只在少数关键位置用蓝色（标题竖线、选中卡片、预览卡左边框），
 * 其余保持中性色 —— 点缀比通体上色更耐看。
 */
.dsho-sec{display:flex;flex-direction:column;gap:10px}
.dsho-sec-title{
  display:flex;align-items:center;gap:8px;
  font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);
}
.dsho-sec-title::before{
  content:'';flex:none;
  width:3px;height:14px;border-radius:2px;
  background:var(--dsw-alias-brand-primary);
}
.dsho-sec-hint{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}

/*
 * 卡片式选择器（对齐官方「外观」那组设置的形态）：
 * 图标在上、文字在下，整块可点。选中时品牌蓝描边 + 极浅蓝底。
 */
.dsho-cards{display:grid;gap:10px;width:100%}
.dsho-card-btn{
  appearance:none;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:9px;
  min-height:76px;padding:14px 10px;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-panel);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary);
  font:inherit;cursor:pointer;
  transition:border-color .12s,background-color .12s,color .12s,box-shadow .12s;
}
.dsho-card-btn:hover:not(:disabled){
  border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary);
}
.dsho-card-btn:disabled{opacity:.5;cursor:default}
.dsho-card-btn[data-on="true"]{
  border-color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-brand-primary);
  box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dsho-card-icon{display:block;flex:none;width:20px;height:20px}
.dsho-card-label{display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:500;line-height:18px;white-space:nowrap}
/* 「优先」这类小标签：跟随品牌色，透明底，不抢主文字的注意力 */
.dsho-card-badge{
  font-size:10px;line-height:14px;font-weight:500;
  padding:0 5px;border-radius:999px;
  color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 25%,transparent);
}

/* 下拉：自绘，避免原生 select 与主题不一致 */
.dsho-select{position:relative;display:block;width:100%}
.dsho-select-btn{
  appearance:none;display:flex;align-items:center;gap:8px;
  width:100%;height:38px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;text-align:left;
  cursor:pointer;
}
.dsho-select-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.dsho-select-btn:disabled{opacity:.5;cursor:default}
.dsho-select-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsho-select-caret{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-secondary)}
.dsho-menu{
  position:absolute;top:calc(100% + 4px);left:0;right:0;
  max-height:300px;overflow-y:auto;
  padding:5px;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-overlay);
  box-shadow:var(--dsw-elevation-soft);
  z-index:60;
}
.dsho-opt{
  appearance:none;display:flex;align-items:center;gap:8px;
  width:100%;padding:9px 10px;border:0;background:transparent;
  border-radius:calc(var(--dsw-radius-sm) - 2px);
  font:inherit;font-size:13px;text-align:left;
  color:var(--dsw-alias-label-secondary);
  cursor:pointer;
}
.dsho-opt:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsho-opt[data-on="true"]{color:var(--dsw-alias-brand-primary);font-weight:600}
.dsho-opt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsho-opt-tag{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dsho-check{flex:none;width:14px;height:14px}
/* 自定义提示词输入框 */
.dsho-textarea{
  width:100%;min-height:180px;resize:vertical;
  padding:11px 13px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;line-height:21px;
}
.dsho-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsho-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsho-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsho-status[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.dsho-status[data-kind="err"]{color:var(--dsw-alias-state-error-primary)}
.dsho-card{
  padding:14px 16px;
  border:1px solid var(--dsw-alias-border-l1);
  border-left:2px solid var(--dsw-alias-brand-primary);
  border-radius:var(--dsw-radius-panel);
  background:var(--dsw-alias-bg-layer-1);
  display:flex;flex-direction:column;gap:7px;
  /* 固定最小高度：切换档位时提示词长度差很多，
     不锁高度会让整页上下跳动，看起来像"闪了一下"。 */
  min-height:168px;
}
.dsho-preview{
  font-size:12px;line-height:19px;
  color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;word-break:break-word;
  max-height:240px;overflow-y:auto;
}
/* 内容换档时淡入，而不是硬切。key 变化会重建节点，动画才会重放。 */
.dsho-fade{animation:dsho-fadein .16s ease-out}
@keyframes dsho-fadein{from{opacity:0}to{opacity:1}}
/* 免费通道连通性探测行 */
.dsho-probe{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:8px 10px;
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
}
.dsho-probe-dot{
  flex:none;width:8px;height:8px;border-radius:999px;
  background:var(--dsw-alias-label-tertiary);
}
.dsho-probe-dot[data-state="testing"]{animation:dsho-probe-pulse 1s ease-in-out infinite}
.dsho-probe-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}
.dsho-probe-dot[data-state="fail"]{background:var(--dsw-alias-state-error-primary)}
.dsho-probe-dot[data-kind="warn"]{background:var(--dsw-alias-state-warn-primary)}
@keyframes dsho-probe-pulse{0%,100%{opacity:.3}50%{opacity:1}}
.dsho-probe-text{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsho-probe-text[data-state="ok"]{color:var(--dsw-alias-state-success-primary)}
.dsho-probe-text[data-state="fail"]{color:var(--dsw-alias-state-error-primary)}
/* 密钥失效属于「配置问题」：功能仍可用（自动回退），用警告色更贴近事实 */
.dsho-probe-text[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dsho-probe-retry{
  appearance:none;flex:none;height:24px;padding:0 10px;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;
  background:transparent;
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:11px;font-weight:500;
  cursor:pointer;
  transition:background-color .1s,border-color .1s;
}
.dsho-probe-retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsho-probe-retry:disabled{opacity:.5;cursor:default}
/* 免费通道卡片：自适应高度，不继承预览卡的最小高度 */
.dsho-card-auto{min-height:0}
.dsho-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.dsho-row-label{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsho-row-name{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dsho-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsho-status[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary)}
/* 开关：与宿主设置页同款 40×24 / 圆点 20 / 位移 16 */
.dsho-switch{
  position:relative;flex:none;
  width:40px;height:24px;padding:0;
  border:0;border-radius:999px;
  background:var(--dsw-alias-border-l2);
  cursor:pointer;transition:background-color .15s;
}
.dsho-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}
.dsho-knob{
  position:absolute;top:2px;left:2px;
  width:20px;height:20px;border-radius:999px;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);
  transition:transform .15s;
}
.dsho-switch[aria-checked="true"] .dsho-knob{transform:translateX(16px)}
`

    /**
     * 浮层样式单独一份。
     *
     * 必须跟着浮层组件一起渲染：shell.overlay 与设置页是两个独立槽位，
     * 设置页里注入的 <style> 管不到浮层 —— 早先共用 PAGE_CSS 时浮层完全没样式，
     * 退化成浏览器默认排版，还盖到了侧边栏上。
     */
    const TOAST_CSS = `
/*
 * 对齐原生设计系统：
 *   · 卡片 —— bg-layer-2 + 1px border-l1 + radius-lg(16px) + elevation-soft，
 *     与宿主的对话框同一个配方；用 radius-panel(28px) 会圆得像气泡。
 *   · 按钮 —— 胶囊形（999px），主按钮用 button-primary-fill 填充，
 *     文字色必须用 label-primary-foreground（反色）。早先用 #fff 配白色品牌色，
 *     字和底一个颜色，看起来就是个空白块。
 */
.dsho-toast{
  position:fixed;right:16px;bottom:16px;z-index:1000;
  width:300px;max-width:calc(100vw - 32px);
  display:flex;flex-direction:column;gap:8px;
  padding:12px 14px;
  box-sizing:border-box;
  border-radius:var(--dsw-radius-lg,16px);
  border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-elevation-soft);
  animation:dsho-toast-in .16s ease-out;
}
@keyframes dsho-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dsho-toast-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsho-toast-body{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsho-toast-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:2px}
.dsho-toast-btn{
  appearance:none;
  height:28px;padding:0 14px;
  border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);
  background:transparent;
  color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-weight:500;
  cursor:pointer;
  transition:background-color .1s,border-color .1s,color .1s;
}
.dsho-toast-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsho-toast-btn:disabled{opacity:.5;cursor:default}
.dsho-toast-btn[data-primary="true"]{
  border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));
  color:var(--dsw-alias-label-primary-foreground,#fff);
}
.dsho-toast-btn[data-primary="true"]:hover:not(:disabled){
  border-color:var(--dsw-alias-button-primary-fill-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));
  background:var(--dsw-alias-button-primary-fill-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)));
}
`

    // ── 图标 ──────────────────────────────────────────────────────────────

    /** 双星（优化）。14px 线性风格，与宿主图标一致。 */
    function SparkIcon(props) {
      return h('svg', {
        className: 'dsho-icon' + (props.spin ? ' dsho-spin' : ''),
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }),
        h('path', { d: 'M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' })
      )
    }

    /** 退回：左弯箭头（撤销这次优化）。与双星成对，14px 线性风格。 */
    function UndoIcon() {
      return h('svg', {
        className: 'dsho-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M9 14L4 9l5-5' }),
        h('path', { d: 'M4 9h9a7 7 0 0 1 7 7v1' })
      )
    }

    /** 取消：方块（中止正在跑的优化）。与双星/左弯箭头同一套线性风格。 */
    function StopIcon() {
      return h('svg', {
        className: 'dsho-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('rect', { x: '6', y: '6', width: '12', height: '12', rx: '2' }))
    }

    /** 高度手柄图标：上下箭头（上下拖 = 改高度）。灰色，悬停变品牌蓝。 */
    function ResizeGripIcon() {
      return h('svg', {
        className: 'dsho-dock-grip-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M8 9l4-4 4 4' }),
        h('path', { d: 'M8 15l4 4 4-4' })
      )
    }

    /** 左侧边缘手柄图标：竖线 + 朝左的小箭头（向左扩 = 往里拖）。 */
    function EdgeLeftIcon() {
      return h('svg', {
        className: 'dsho-dock-edge-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M12 5v14' }),
        h('path', { d: 'M9 9l-4 3 4 3' })
      )
    }

    /** 右侧边缘手柄图标：竖线 + 朝右的小箭头。 */
    function EdgeRightIcon() {
      return h('svg', {
        className: 'dsho-dock-edge-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M12 5v14' }),
        h('path', { d: 'M15 9l4 3-4 3' })
      )
    }

    function CaretIcon() {
      return h('svg', {
        className: 'dsho-select-caret',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M6 9l6 6 6-6' }))
    }

    function CheckIcon() {
      return h('svg', {
        className: 'dsho-check',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M4 12l5 5L20 6' }))
    }

    /** 选项卡片用的线性图标，统一 20px、currentColor、2px 描边。 */
    function LineIcon(props) {
      return h('svg', {
        className: 'dsho-card-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, props.children)
    }

    /** 自动：循环箭头（跟随）。 */
    function IconAuto() {
      return h(LineIcon, null,
        h('path', { d: 'M20 11a8 8 0 10-2.6 6' }),
        h('path', { d: 'M20 4v7h-7' })
      )
    }

    /** 手动：滑块（自己指定）。 */
    function IconManual() {
      return h(LineIcon, null,
        h('path', { d: 'M4 8h10M18 8h2M4 16h4M12 16h8' }),
        h('circle', { cx: 16, cy: 8, r: 2.2 }),
        h('circle', { cx: 10, cy: 16, r: 2.2 })
      )
    }

    /** 免费通道：闪电（不花额度、即开即用）。 */
    function IconFree() {
      return h(LineIcon, null,
        h('path', { d: 'M13 3L5 13h6l-1 8 8-10h-6l1-8z' })
      )
    }

    /**
     * 精简：压缩。
     *
     * 之前三个档位的图标都是横线（两行、三行、文档），语义重叠，
     * 一眼看过去全是"文本行"，分不出区别。现在改成各不相同的意象：
     *   精简 = 上下两条边夹住一个向下的箭头，表示把内容压短；
     *   均衡 = 天平，表示不多不少；
     *   详细 = 放大镜里看到文字，表示看得更细。
     */
    function IconBrief() {
      return h(LineIcon, null,
        h('path', { d: 'M4 5h16' }),
        h('path', { d: 'M4 19h16' }),
        h('path', { d: 'M12 8.5v5.5' }),
        h('path', { d: 'M8.8 11l3.2 3.2 3.2-3.2' })
      )
    }

    /** 均衡：天平。 */
    function IconBalanced() {
      return h(LineIcon, null,
        h('path', { d: 'M12 4v15' }),
        h('path', { d: 'M7 19h10' }),
        h('path', { d: 'M5 7h14' }),
        h('path', { d: 'M5 7l-2.6 5.6h5.2z' }),
        h('path', { d: 'M19 7l2.6 5.6h-5.2z' })
      )
    }

    /**
     * 详细：四角向外展开。
     *
     * 与「精简」的向内压缩箭头正好成对：一个收、一个放，形态对称、
     * 语义一眼可辨，而且全是简单折线，20px 下不会糊。
     * 试过放大镜方案，但镜片里的文字缩到 20px 只有 1px 高，糊成一团。
     */
    function IconDetailed() {
      return h(LineIcon, null,
        h('path', { d: 'M9 4H4v5' }),
        h('path', { d: 'M15 4h5v5' }),
        h('path', { d: 'M4 15v5h5' }),
        h('path', { d: 'M20 15v5h-5' })
      )
    }

    /** 自定义：铅笔。 */
    function IconCustom() {
      return h(LineIcon, null,
        h('path', { d: 'M4 20h4L19 9l-4-4L4 16z' }),
        h('path', { d: 'M14 6l4 4' })
      )
    }

    // ── 通用控件 ──────────────────────────────────────────────────────────

    /**
     * 卡片式选择器。
     *
     * 取代原来的胶囊分段：官方「外观」那组设置用的是大卡片（图标在上、文字在下），
     * 目标明确、点击热区大、选中态清楚。这里照同样的结构做，
     * 选中时用品牌蓝描边加浅蓝底，与整页的强调色统一。
     */
    function CardChoice(props) {
      return h('div', {
        className: 'dsho-cards',
        style: { gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` },
        role: 'radiogroup',
      }, props.options.map((option) => h('button', {
        key: option.id,
        type: 'button',
        role: 'radio',
        className: 'dsho-card-btn',
        'data-on': props.value === option.id ? 'true' : 'false',
        'aria-checked': props.value === option.id,
        disabled: props.disabled === true,
        onClick: () => props.onChange(option.id),
        title: option.summary,
      },
        h(option.Icon),
        h('span', { className: 'dsho-card-label' },
          option.label,
          option.badge === undefined
            ? null
            : h('span', { className: 'dsho-card-badge' }, option.badge)
        )
      )))
    }

    /** 下拉单选：选项多时用。自绘，点击外部关闭。 */
    function Select(props) {
      const [open, setOpen] = useState(false)
      const boxRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (boxRef.current !== null && !boxRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const current = props.options.find((option) => option.value === props.value)

      return h('div', { className: 'dsho-select', ref: boxRef },
        h('button', {
          type: 'button',
          className: 'dsho-select-btn',
          disabled: props.disabled === true,
          onClick: () => setOpen((previous) => !previous),
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
        },
          h('span', { className: 'dsho-select-value' },
            current === undefined ? (props.placeholder ?? '请选择') : current.label),
          h(CaretIcon)
        ),
        open
          ? h('div', { className: 'dsho-menu', role: 'listbox' },
              props.options.length === 0
                ? h('div', { className: 'dsho-opt' }, '没有可用选项')
                : props.options.map((option) => h('button', {
                    key: option.value,
                    type: 'button',
                    role: 'option',
                    className: 'dsho-opt',
                    'data-on': option.value === props.value ? 'true' : 'false',
                    'aria-selected': option.value === props.value,
                    onClick: () => {
                      props.onChange(option.value)
                      setOpen(false)
                    },
                  },
                    h('span', { className: 'dsho-opt-name' }, option.label),
                    option.tag === undefined ? null : h('span', { className: 'dsho-opt-tag' }, option.tag),
                    option.value === props.value ? h(CheckIcon) : null
                  ))
            )
          : null
      )
    }

    // ── 网络 ──────────────────────────────────────────────────────────────

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        // 把错误码挂在异常上：上层要按码分支时不必去啃中文文案。
        const failure = new Error(data.error || `HTTP ${response.status}`)
        if (typeof data.code === 'string') failure.code = data.code
        throw failure
      }
      return data
    }

    /**
     * 发起优化（一次性，等全部生成完才回）。
     *
     * 不用 postJson：它把 ok:false 一律当错误抛出去，会把服务端标好的
     * `aborted`（用户点了取消）也吞成异常 —— 取消不是失败，不该弹红色报错。
     *
     * requestId 由客户端生成：取消时凭它让服务端找到同一个任务并中止。
     */
    async function optimize(text, sessionId, requestId) {
      const response = await fetch('/dsh-prompt-optimizer/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sessionId, requestId }),
      })
      const data = await response.json().catch(() => ({}))
      return data
    }

    /**
     * 解析一段 SSE 文本，取出事件名与数据。
     *
     * SSE 一条事件长这样：
     *   event: delta
     *   data: {"text":"..."}
     *
     * @param {string} raw 一条完整事件（不含结尾的空行）
     * @returns {{event: string, data: object}|null}
     */
    function parseSseEvent(raw) {
      if (typeof raw !== 'string') return null
      let event = 'message'
      const dataLines = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        }
      }
      if (dataLines.length === 0) return null
      let data = {}
      try {
        data = JSON.parse(dataLines.join('\n'))
      } catch {
        return null
      }
      return { event, data }
    }

    /**
     * 退回一次性接口：等模型全部生成完再返回，没有实时反馈但一定拿得到结果。
     *
     * 回执结构与流式的 done 事件同构（text / provider / model / style / usage），
     * 调用方不需要区分这次走的是哪条路。
     */
    async function fallbackToOneShot(text, sessionId, requestId, hooks) {
      const data = await optimize(text, sessionId, requestId).catch((error) => ({
        ok: false,
        error: error && error.message ? error.message : String(error),
      }))
      if (data && data.ok === true && typeof data.text === 'string' && data.text.length > 0) {
        // 一次性接口没有 start 事件，这里补一次，界面才能显示用的是什么模型。
        if (typeof hooks?.onStart === 'function') {
          hooks.onStart({
            provider: data.provider,
            model: data.model,
            style: data.style,
            source: data.source,
          })
        }
        if (typeof hooks?.onText === 'function') hooks.onText(data.text)
      }
      return data && typeof data === 'object' ? data : { ok: false, error: '接口没有返回内容' }
    }

    /**
     * 发起流式优化：边收边把进度交给 hooks。
     *
     * 服务端推的事件：
     *   start → {provider, model, style, source}
     *   delta → {text}   当前累计正文（整段，不是增量）
     *   revise → {reason, text} 要整段换稿了（收敛 / 补齐 / 拉回）
     *   reasoning → {text} 模型的思考过程
     *   done  → {ok, text, usage, elapsedMs, ...}
     *   error / aborted → {error}
     *
     * 三种情况会退回**一次性接口 /optimize**（而不是把 /stream 的响应硬当成结果）：
     *   - 宿主没有 /stream 这条路由（老版 host 半区返回 404/405）；
     *   - 中间的代理把 SSE 改成了普通 JSON（Content-Type 不是 text/event-stream）；
     *   - 当前环境拿不到可读流（没有 response.body.getReader）。
     * 退回后结果照样拿得到，只是没有实时反馈。
     */
    async function streamOptimize(text, sessionId, requestId, hooks) {
      let response
      try {
        response = await fetch('/dsh-prompt-optimizer/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, sessionId, requestId }),
        })
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) }
      }

      const canStream = response.body !== undefined
        && response.body !== null
        && typeof response.body.getReader === 'function'
      const status = typeof response.status === 'number' ? response.status : 200
      const contentType = typeof response.headers?.get === 'function'
        ? (response.headers.get('content-type') || '')
        : ''
      // 声明了类型就必须是 SSE；没声明（老环境、测试桩）就当它是 SSE 继续读，
      // 免得把一个能用的流误判成不可用。
      const declaresSse = contentType.length === 0 || contentType.includes('text/event-stream')
      // 三条不满足任意一条就换一条真正能出结果的接口：
      //   状态 ≥ 400（宿主没有这条路由）／拿不到可读流／声明了却不是 SSE（被代理改了）。
      // 早先这里直接 response.json() 去解析**/stream 的响应**，404 时 data.text 是
      // undefined，用户只看到「模型返回了空内容」，而那条早就写好的 optimize()
      // 从来没有被调用过 —— 回退分支名存实亡。
      if (!canStream || status >= 400 || !declaresSse) {
        return fallbackToOneShot(text, sessionId, requestId, hooks)
      }

      const reader = response.body.getReader()
      const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null
      let buffer = ''
      let result = null
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done === true) break
        buffer += decoder !== null
          ? decoder.decode(chunk.value, { stream: true })
          : String(chunk.value)
        let index = buffer.indexOf('\n\n')
        while (index !== -1) {
          const raw = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const event = parseSseEvent(raw)
          if (event !== null) {
            if (event.event === 'start') hooks.onStart(event.data)
            else if (event.event === 'delta') hooks.onText(event.data.text)
            else if (event.event === 'revise') hooks.onRevise?.(event.data)
            else if (event.event === 'reasoning') hooks.onReasoning(event.data.text)
            else if (event.event === 'done') result = event.data
            else if (event.event === 'error') {
              // code 是稳定契约（ABORTED / EMPTY_INPUT / TOO_LONG / EMPTY_OUTPUT / UNKNOWN）；
              // error 文案随时可能改，判断逻辑不能挂在它上面。
              result = { ok: false, error: event.data.error, code: event.data.code }
            }
            else if (event.event === 'aborted') {
              result = { ok: false, aborted: true, error: event.data.error || '已取消' }
            }
          }
          index = buffer.indexOf('\n\n')
        }
      }
      if (result === null) return { ok: false, error: '流式响应提前结束了，请重试' }
      return result
    }

    /** 中止一次正在跑的优化。 */
    async function abortOptimize(requestId) {
      const response = await fetch('/dsh-prompt-optimizer/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      })
      const data = await response.json().catch(() => ({}))
      return data
    }

    /**
     * 探测免费通道。
     *
     * 不用 postJson：它把 ok:false 当成错误抛出去，会把服务端分好的
     * `kind`（auth / rate / timeout …）丢掉 —— 而界面恰恰要靠 kind 区分
     * 「密钥作废」和「临时抖动」，两者的说法和出路完全不同。
     */
    async function probeFreeChannel(force) {
      const query = force === true ? '?force=1' : ''
      const response = await fetch(`/dsh-prompt-optimizer/free-channel/test${query}`)
      const data = await response.json().catch(() => ({}))
      return data
    }

    async function readSettings(sessionId) {
      const query = typeof sessionId === 'string' && sessionId.length > 0
        ? `?sessionId=${encodeURIComponent(sessionId)}`
        : ''
      const response = await fetch(`/dsh-prompt-optimizer/settings${query}`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok === false) {
        // 把错误码挂在异常上：上层要按码分支时不必去啃中文文案。
        const failure = new Error(data.error || `HTTP ${response.status}`)
        if (typeof data.code === 'string') failure.code = data.code
        throw failure
      }
      return data
    }

    /** 路由来源的可读说明。 */
    const SOURCE_LABEL = {
      manual: '设置里手动指定',
      session: '当前对话实际在用',
      default: '默认模型',
      config: '配置文件兜底',
    }

    // ── 输入框按钮 ────────────────────────────────────────────────────────

    /**
     * 优化结果的状态。
     *
     * 结果不直接覆盖草稿 —— 它先落在输入框上方的预览卡里，用户确认后才写回。
     * 按钮（conversation.input.right）和预览卡（conversation.input.dock）住在
     * 两个不同的槽位里，没有共同的父组件，所以状态只能放在模块级，
     * 再用订阅把变化推给两边。
     */
    // ── 历史版本 ──────────────────────────────────────────────────────────

    /*
     * 每次优化成功都留一版。
     *
     * 为什么要有：同一段话常常要试两三次 —— 换个档位、换个模型、或者
     * 「重新优化」碰上一版更差的。没有历史就只能靠记忆比，比完还得重跑一次。
     *
     * 存在 localStorage（按浏览器算，不跟会话走）：关掉页面再打开还在。
     * 只留最近 HISTORY_LIMIT 条，超出的从最旧的开始丢 —— 结果正文可能几千字，
     * 不封顶会把 localStorage 塞爆（浏览器上限一般 5MB）。
     */
    const HISTORY_KEY = 'dsho.preview.history'
    const HISTORY_LIMIT = 20
    /** 列表里每条显示的摘要长度（正文太长，列表里只给一眼）。 */
    const HISTORY_SNIPPET = 90

    /** 本次会话内记住的历史（localStorage 写不进去时兜底）。 */
    let historyMemory = []
    /** 上一次写入是否失败（配额满/隐私模式）。失败过才把内存当权威。 */
    let historyStorageBroken = false

    /**
     * 读历史。
     *
     * 语义是「localStorage 说了算」：
     *   - 有值 → 用它（坏数据过滤掉，别让一条烂记录拖垮整个列表）；
     *   - 没有值（key 不存在）→ **空数组**，不是内存里的旧值。
     *     这条很关键：用户在别处清了浏览器数据、或者测试里清过 key，
     *     界面就得跟着变空，不能还端着上一次的列表。
     *   - 只有上一次写入失败过（写不进 localStorage）时，才退回内存 ——
     *     否则刚加的那版会因为「存不下」而立刻消失。
     */
    function readHistory() {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(HISTORY_KEY)
          if (raw !== null && raw !== undefined && String(raw) !== '') {
            const parsed = JSON.parse(String(raw))
            if (Array.isArray(parsed)) {
              const list = parsed.filter((item) => item && typeof item.result === 'string')
                .slice(0, HISTORY_LIMIT)
              historyMemory = list
              historyStorageBroken = false
              return list
            }
          } else if (!historyStorageBroken) {
            historyMemory = []
            return []
          }
        }
      } catch {
        /* 存的内容坏了就退回内存里的值 */
      }
      return historyMemory
    }

    /** 写历史。存不下（配额满）就把更旧的砍一半再试一次，再不行就只留内存。 */
    function writeHistory(list) {
      const trimmed = list.slice(0, HISTORY_LIMIT)
      historyMemory = trimmed
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed))
          historyStorageBroken = false
        }
      } catch {
        // 配额满了：先砍一半再试一次，还不行就认命，只在本次会话内有效。
        historyStorageBroken = true
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed.slice(0, Math.floor(HISTORY_LIMIT / 2))))
            historyStorageBroken = false
          }
        } catch {
          /* 还是存不下就只在本次会话内有效 */
        }
      }
      return trimmed
    }

    /** 时间戳 → HH:MM（不用 toLocaleTimeString：各环境时区/格式不一致，列表会跳）。 */
    function formatHistoryTime(at) {
      const date = new Date(Number(at))
      if (!Number.isFinite(date.getTime())) return ''
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      return pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /**
     * 一条历史的「过程标签」。
     *
     * 历史列表光记档位是不够的：同样是 detailed，一版是模型一次写对，
     * 另一版是被档位兜底截短过的。不写出来，用户会以为差别只是措辞。
     */
    function historyBadges(entry) {
      const meta = entry && entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
      const badges = []
      if (meta.adjusted === 'trimmed') {
        badges.push({ text: '已收敛', kind: 'adjust', title: '模型写超了，按档位上限删短过' })
      } else if (meta.adjusted === 'expanded') {
        badges.push({ text: '已补齐', kind: 'adjust', title: '模型只改了措辞，按档位下限补写过' })
      }
      if (meta.recovered === true) {
        badges.push({ text: '已拉回', kind: 'recover', title: '模型把一句话扩成了文档，已改回克制写法' })
      }
      if (meta.freeUsed === true) {
        badges.push({ text: '免费通道', kind: 'free', title: '这一版由免费通道生成' })
      }
      return badges
    }

    /** 一条历史在列表里的一句话摘要。 */
    function historySnippet(entry) {
      const text = typeof entry.result === 'string' ? entry.result.replace(/\s+/g, ' ').trim() : ''
      if (text.length <= HISTORY_SNIPPET) return text
      return text.slice(0, HISTORY_SNIPPET) + '…'
    }

    /**
     * 逐行对比两版正文。
     *
     * 用最朴素的 LCS：行数不多（提示词一般几十到几百行），够快也够准。
     * 行数太夸张（两边乘起来超过 DIFF_LIMIT）就放弃逐行标记，只并排显示 ——
     * 不能让一次对比把界面卡住。
     */
    const DIFF_LIMIT = 400000

    /**
     * 补一条空占位行。
     *
     * 并排对比的两栏各占一半宽度，只有**行数相同**才有「这一行对应那一行」
     * 的读法。一侧被删/被加的行，另一侧必须补一条等高的空行，
     * 否则两边从这一行往下全部错位 —— 用户会以为改动跑到别处去了。
     */
    function fillerLine() {
      /*
       * 空白占位也算「这一处有改动」：对面那一行被删/被加，
       * 这边空出来的就是改动的一部分，标成未改动反而会让人以为「这行没变」。
       */
      return { text: '', changed: true, filler: true }
    }

    function diffLines(leftText, rightText) {
      const left = String(leftText == null ? '' : leftText).split('\n')
      const right = String(rightText == null ? '' : rightText).split('\n')
      // 行数太多时不做逐行比对，但**仍然逐行对齐**：多的那边补空占位。
      if (left.length * right.length > DIFF_LIMIT) {
        const rows = Math.max(left.length, right.length)
        const outLeft = []
        const outRight = []
        for (let i = 0; i < rows; i++) {
          outLeft.push(i < left.length ? { text: left[i], changed: false } : fillerLine())
          outRight.push(i < right.length ? { text: right[i], changed: false } : fillerLine())
        }
        return { left: outLeft, right: outRight, changed: 0 }
      }

      const rows = left.length
      const cols = right.length
      // table[i][j] = left[i..] 与 right[j..] 的最长公共子序列长度。
      const table = []
      for (let i = 0; i <= rows; i++) table.push(new Array(cols + 1).fill(0))
      for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
          table[i][j] = left[i] === right[j]
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1])
        }
      }

      const outLeft = []
      const outRight = []
      let changed = 0
      let i = 0
      let j = 0
      while (i < rows && j < cols) {
        if (left[i] === right[j]) {
          outLeft.push({ text: left[i], changed: false })
          outRight.push({ text: right[j], changed: false })
          i += 1
          j += 1
          continue
        }
        /*
         * 两边这一行不一样：按 LCS 表判断是「左边被删」还是「右边被加」。
         *
         * 两条铁律：
         *   1. **每次只推进一侧**，另一侧必须补一条空占位行 ——
         *      否则两栏从这行起行号错开，后面每一行都和对面那行对不上。
         *   2. **推进的那一侧本行只输出一次**，不推进的那一侧不能顺手也 push
         *      自己当前这行 —— 那会让它重复出现在连续几行里。
         */
        if (table[i + 1][j] >= table[i][j + 1]) {
          outLeft.push({ text: left[i], changed: true })
          outRight.push(fillerLine())
          i += 1
        } else {
          outLeft.push(fillerLine())
          outRight.push({ text: right[j], changed: true })
          j += 1
        }
        changed += 1
      }
      while (i < rows) {
        outLeft.push({ text: left[i], changed: true })
        outRight.push(fillerLine())
        changed += 1
        i += 1
      }
      while (j < cols) {
        outLeft.push(fillerLine())
        outRight.push({ text: right[j], changed: true })
        changed += 1
        j += 1
      }

      return { left: outLeft, right: outRight, changed }
    }

    /** 最近一次对比结果。左右都是同一批字符串对象，按值比较很快。 */
    let diffMemo = { left: null, right: null, value: null }

    function getDiff(leftText, rightText) {
      if (diffMemo.left === leftText && diffMemo.right === rightText) return diffMemo.value
      const value = diffLines(leftText, rightText)
      diffMemo = { left: leftText, right: rightText, value }
      return value
    }

    const previewStore = {
      state: {
        history: readHistory(), // 历史版本（reset 不清空：它是账本，不是当前任务）
        viewing: null,      // 正在看哪一版历史（null = 看当前结果）
        compareId: '',      // 选中对比的那条历史 id
        phase: 'idle',      // idle | running | ready
        requestId: '',      // 取消时凭它找到同一个任务
        /*
         * 这份结果是哪个会话的。
         *
         * previewStore 是模块级单例，一个浏览器标签只此一份 —— 但界面里可以
         * 同时开着好几个对话。不记归属的话，在 A 里点优化、切到 B，
         * B 的输入框上方照样挂着 A 的结果，用户会以为那是 B 的。
         */
        ownerSessionId: '',
        source: '',         // 发起优化时的输入
        original: '',       // 优化前的原文，用于「退回」
        result: '',         // 优化结果（流式过程中是「到目前为止」的正文）
        conflict: false,    // 等待期间用户改过输入
        comparingOriginal: false, // 正在「结果 vs 原文」并排看
        meta: null,         // 模型、档位等回执
        adopted: false,     // 结果是否已被采用
        streaming: false,   // 是否正在流式接收
        revising: '',       // 换稿提示：非空表示「正在按档位重写」，内容是原因
        reasoning: '',      // 模型的思考过程（模型不给就没有）
        elapsedMs: null,    // 用时（毫秒）
        usage: null,        // token 用量 {inputTokens, outputTokens, ...}
      },
      listeners: new Set(),
      getDraft: null,      // 由按钮注入：读当前草稿
      setDraft: null,      // 由按钮注入：写草稿
      sessionId: undefined,
      subscribe(listener) {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      set(patch) {
        this.state = { ...this.state, ...patch }
        for (const listener of Array.from(this.listeners)) listener(this.state)
      },
      reset() {
        // history 是账本，不随当前任务清空；viewing / compareId 属于当前视图，一起复位。
        this.set({
          phase: 'idle', requestId: '', ownerSessionId: '', source: '', original: '',
          result: '', conflict: false, meta: null, adopted: false,
          streaming: false, revising: '', reasoning: '', elapsedMs: null, usage: null,
          viewing: null, compareId: '', comparingOriginal: false,
        })
      },
    }

    /**
     * 预览卡（整张卡片）的尺寸偏好。
     *
     * 位置固定 —— 卡片永远在预览卡槽位里、输入框上方，不提供任何位移交互。
     * 高度可调 —— 顶部那条手柄拖动改整张卡片的高度，方向键微调；高度记住。
     * 宽度可调 —— 左右两条边缘手柄各自独立地拉宽/收窄整张卡片。
     */
    const PREVIEW_SIZE_KEY = 'dsho.preview.body-height'
    const PREVIEW_WIDTH_KEY = 'dsho.preview.body-width'
    const PREVIEW_MIN_HEIGHT = 160
    const PREVIEW_MAX_HEIGHT = 720
    const PREVIEW_DEFAULT_HEIGHT = 220
    /** 卡片上沿与视口顶部之间至少留出的空隙（和边缘手柄留 12px 是同一个思路）。 */
    const PREVIEW_VIEWPORT_MARGIN = 16

    /**
     * 宽度用「左右两侧各扩出多少 px」来记，而不是记总宽度。
     *
     * 这样两侧互不影响：左边扩 100 就只动左边，右边扩 100 就只动右边，
     * 拖动一侧绝不会把另一侧挤走。数值可以为负（往里收窄）。
     */
    const PREVIEW_MAX_EXPAND_PX = 240
    const PREVIEW_MAX_NARROW_RATIO = 0.4
    /** 持久化时的兜底下限（没量到容器宽度时用）。 */
    const PREVIEW_PERSIST_MIN_INSET = -800

    /** 本次会话内记住的高度（宿主端口每次启动都变，localStorage 不可靠，先用它兜底）。 */
    let previewHeightMemory = null
    /** 本次会话内记住的左右扩出量。 */
    let previewWidthMemory = null

    /**
     * 夹住卡片高度。
     *
     * 上限有两个：写死的 PREVIEW_MAX_HEIGHT（720），以及**当前视口实际还剩多少**。
     * 后者由调用方量出来传进来（maxHeight）；量不到就退回 720 ——
     * 卡片贴在视口底部，高度一旦超过「下沿到视口顶部」的距离，上沿就会跑出屏幕。
     */
    function clampPreviewHeight(value, maxHeight) {
      const number = Number(value)
      const limit = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : PREVIEW_MAX_HEIGHT
      const max = Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, Math.floor(limit)))
      if (!Number.isFinite(number)) return Math.min(PREVIEW_DEFAULT_HEIGHT, max)
      return Math.min(max, Math.max(PREVIEW_MIN_HEIGHT, Math.round(number)))
    }

    /**
     * 量出这张卡片在当前视口里最多能长多高。
     *
     * 卡片挂在输入框上方的槽位里，整条 composer 是贴底绝对定位的，
     * 所以卡片**下沿的位置是固定的**：高度往上长多少，上沿就往上走多少。
     * 于是可用高度 = 下沿到视口顶部的距离 - 一点余量。
     *
     * 量不到（没有 dock、没有 innerHeight、或者矩形不可用）就返回 undefined，
     * 交给 clampPreviewHeight 退回写死的上限。
     */
    function measureMaxPreviewHeight(dock) {
      if (!dock || typeof dock.getBoundingClientRect !== 'function') return undefined
      const viewportHeight = typeof window !== 'undefined' ? Number(window.innerHeight) : NaN
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return undefined
      const rect = dock.getBoundingClientRect()
      const bottom = rect && Number.isFinite(rect.bottom) ? rect.bottom : NaN
      if (!Number.isFinite(bottom) || bottom <= 0) return undefined
      return Math.floor(bottom - PREVIEW_VIEWPORT_MARGIN)
    }

    /**
     * 夹住单侧的扩出量（单位 px，1:1 对应拖动距离）。
     *
     * 往外最多扩到「窗口里还剩多少空间」（limits.max），往里（负值）最多收掉
     * 容器宽度的 PREVIEW_MAX_NARROW_RATIO —— 保证窗口不会被拖到看不见，
     * 也不会溢出视口（溢出会让宿主出现横向滚动条）。
     */
    function clampPreviewInset(value, limits) {
      const number = Number(value)
      if (!Number.isFinite(number)) return 0
      const max = limits && Number.isFinite(limits.max) ? limits.max : PREVIEW_MAX_EXPAND_PX
      const min = limits && Number.isFinite(limits.min) ? limits.min : PREVIEW_PERSIST_MIN_INSET
      return Math.min(max, Math.max(min, Math.round(number)))
    }

    /**
     * 读上次的高度偏好：localStorage → 内存 → null（没调过）。
     *
     * 返回 null 表示「用户还没调过」，这时卡片保持原来的自适应行为
     * （内容多高就多高），和没加手柄之前完全一样。
     */
    function readPreviewHeight() {
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(PREVIEW_SIZE_KEY)
          if (raw !== null && raw !== undefined && String(raw) !== '') {
            const value = clampPreviewHeight(Number(raw))
            previewHeightMemory = value
            return value
          }
        }
      } catch {
        /* 存储不可用（隐私模式/跨域限制）就退回内存里的值 */
      }
      return previewHeightMemory
    }

    /** 记下高度偏好。失败就算了，不影响功能。 */
    function writePreviewHeight(value) {
      const height = clampPreviewHeight(value)
      previewHeightMemory = height
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(PREVIEW_SIZE_KEY, String(height))
        }
      } catch {
        /* 存不下就只在本次会话内有效 */
      }
      return height
    }

    /**
     * 读上次记的左右扩出量：localStorage → 内存 → {left:0,right:0}。
     *
     * 用「扩出量」而不是「总宽度」，这样左右两侧天生独立。
     */
    function readPreviewInsets() {
      const fallback = { left: 0, right: 0 }
      try {
        if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(PREVIEW_WIDTH_KEY)
          if (raw !== null && raw !== undefined && String(raw) !== '') {
            const parsed = JSON.parse(String(raw))
            if (parsed && typeof parsed === 'object') {
              const value = {
                left: clampPreviewInset(parsed.left),
                right: clampPreviewInset(parsed.right),
              }
              previewWidthMemory = value
              return value
            }
          }
        }
      } catch {
        /* 存的内容坏了就退回内存里的值 */
      }
      return previewWidthMemory || fallback
    }

    /** 记下左右扩出量。失败就算了，不影响功能。 */
    function writePreviewInsets(value) {
      const insets = {
        left: clampPreviewInset(value && value.left),
        right: clampPreviewInset(value && value.right),
      }
      previewWidthMemory = insets
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(PREVIEW_WIDTH_KEY, JSON.stringify(insets))
        }
      } catch {
        /* 存不下就只在本次会话内有效 */
      }
      return insets
    }
    /**
     * 发起一次优化。
     *
     * 结果不写回草稿，由预览卡让用户确认后再采用。
     * 等待期间用户如果又改了输入，就标记为冲突：结果不覆盖ta的新内容。
     *
     * 走流式接口：正文边收边显示，用户点下按钮就能看见字在长。
     * 服务端不支持流式时会自动退回一次性接口（streamOptimize 内部处理）。
     */
    async function runOptimize(text, sessionId) {
      const source = typeof text === 'string' ? text.trim() : ''
      if (source.length === 0) return { ok: false, error: '先在输入框里写下要优化的内容' }

      const requestId = `dsho-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      previewStore.set({
        phase: 'running',
        requestId,
        // 记下这次是谁发起的：切到别的对话时，卡片不该跟过去。
        ownerSessionId: typeof sessionId === 'string' ? sessionId : '',
        // 开始新一次优化就退出历史视图，不然新结果被旧的那一版挡着。
        viewing: null,
        compareId: '',
        source,
        original: typeof text === 'string' ? text : '',
        result: '',
        conflict: false,
        meta: null,
        adopted: false,
        streaming: true,
        revising: '',
        reasoning: '',
        elapsedMs: null,
        usage: null,
      })

      /*
       * 这批事件只属于本次请求。
       *
       * 用户连点两次、或者上一次请求的尾巴迟到时，旧事件若照写不误，
       * 新一次优化显示到一半就会被上一版的正文顶掉 —— 屏幕上同样是
       * 「结果突然变成了另一个结果」。requestId 就是这条识别线。
       */
      const isCurrent = () => previewStore.state.requestId === requestId

      const result = await streamOptimize(source, sessionId, requestId, {
        onStart: (data) => {
          if (!isCurrent()) return
          // 一开始就知道用哪个模型、哪一档，界面上先显示出来。
          previewStore.set({
            meta: {
              provider: data.provider,
              model: data.model,
              style: data.style,
              adjusted: null,
              recovered: false,
            },
          })
        },
        onText: (value) => {
          if (!isCurrent()) return
          /*
           * 流式过程中正文是「到目前为止」的内容，直接替换。
           *
           * 顺手剥掉混进来的思考段：结果最后要能一键写回输入框，
           * 只在渲染时剥是不够的 —— 「复制」和「替换草稿」拿的都是这份 state。
           * 用**当前**已收到的 reasoning 做判据，边收边剥。
           */
          previewStore.set({
            result: stripReasoning(
              typeof value === 'string' ? value : '',
              previewStore.state.reasoning,
            ),
          })
        },
        onReasoning: (value) => {
          if (!isCurrent()) return
          previewStore.set({ reasoning: typeof value === 'string' ? value : '' })
        },
        onRevise: (data) => {
          if (!isCurrent()) return
          // 服务端要整段换稿了：把「生成中…」换成具体原因，
          // 用户看到的是「正在按档位重写」，而不是结果自己变掉了。
          const reason = typeof data?.text === 'string' && data.text.length > 0
            ? data.text
            : '正在重写这一版…'
          previewStore.set({ revising: reason })
        },
      })

      // 迟到的这批结果已经不属于当前这次了（用户又点了一次）：
      // 直接丢弃 —— 不写流水账、不改状态，让新请求自己跑完。
      if (!isCurrent()) return { ok: false, stale: true }

      /*
       * 用户在等待期间点了「放弃」：这次结果作废，不许再把卡片写回来。
       *
       * 放弃是把 phase 打回 'idle'，但 requestId 保持不动 —— 它仍指向这次请求。
       * 所以「还是不是当前这次」判不出「用户已经关掉了」。done 一到就无条件
       * 写 phase:'ready'，卡片于是又弹出来，用户得再关一次。
       *
       * 判据：这次请求已经被打回 idle，就说明用户亲手关掉了它。
       */
      if (previewStore.state.phase !== 'running') return { ok: false, dismissed: true }

      // 取消不是失败：不弹红色报错，直接回到原状。
      if (result.aborted === true) {
        previewStore.reset()
        return { ok: false, aborted: true }
      }
      if (result.ok !== true || typeof result.text !== 'string' || result.text.length === 0) {
        previewStore.reset()
        return { ok: false, error: result.error || '模型返回了空内容' }
      }

      const current = typeof previewStore.getDraft === 'function' ? previewStore.getDraft() : ''
      const conflict = typeof current === 'string' && current.trim() !== source
      // 收尾时 reasoning 已经完整，再剥一次 —— 流式期间可能还没收到那段思考。
      const cleanText = stripReasoning(result.text, result.reasoning ?? previewStore.state.reasoning)
      // 结果到手就先记一版历史：用户点「重新优化」再跑一版时，上一版不能丢。
      pushHistory({
        source,
        result: cleanText,
        meta: {
          provider: result.provider,
          model: result.model,
          style: result.style,
          // 这三个值决定了「这一版为什么和那一版不一样」：
          // 走没走免费通道、有没有被档位兜底截短/补齐、有没有从过度扩写里拉回。
          // 只记 provider/model/style 的话，两版看起来只是措辞不同，会误导人。
          adjusted: result.adjusted ?? null,
          recovered: result.recovered === true,
          freeUsed: result.source === 'free',
        },
        elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : null,
      })
      previewStore.set({
        phase: 'ready',
        result: cleanText,
        conflict,
        streaming: false,
        revising: '',
        elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : null,
        usage: result.usage ?? null,
        reasoning: typeof result.reasoning === 'string' ? result.reasoning : '',
        meta: {
          provider: result.provider,
          model: result.model,
          style: result.style,
          adjusted: result.adjusted,
          recovered: result.recovered,
        },
      })
      return { ok: true }
    }

    /**
     * 记一版历史。
     *
     * 新的一条排最前面（列表按时间倒序，最近的在最上面）。
     * id 用「时间戳 + 随机」：同一毫秒内连点两次也不会撞。
     */
    function pushHistory(entry) {
      const list = readHistory()
      const item = {
        id: 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        at: Date.now(),
        source: typeof entry.source === 'string' ? entry.source : '',
        result: typeof entry.result === 'string' ? entry.result : '',
        meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
        elapsedMs: typeof entry.elapsedMs === 'number' ? entry.elapsedMs : null,
      }
      const next = writeHistory([item].concat(list))
      previewStore.set({ history: next })
      return item
    }

    /** 删掉一条历史。删的是正在看的那条，就顺手退回当前结果。 */
    function deleteHistory(id) {
      const next = writeHistory(readHistory().filter((item) => item.id !== id))
      const patch = { history: next }
      if (previewStore.state.viewing && previewStore.state.viewing.id === id) patch.viewing = null
      if (previewStore.state.compareId === id) patch.compareId = ''
      previewStore.set(patch)
    }

    /** 清空历史。 */
    function clearHistory() {
      writeHistory([])
      previewStore.set({ history: [], viewing: null, compareId: '' })
    }

    /** 翻到某一版历史看。只改「显示哪一版」，不动当前结果。 */
    function viewHistory(entry) {
      if (!entry) return
      previewStore.set({
        viewing: entry,
        /*
         * 进历史视图就把「结果 vs 原文」收起来。
         *
         * 两个对比不能叠着：并排那两栏的标题是「原文 / 优化结果」，
         * 而这时候右栏显示的其实是某一版历史 —— 标题和内容对不上，
         * 用户会以为自己在看刚生成的那一版。
         */
        comparingOriginal: false,
        // 同一条再点一次就是收起
        compareId: previewStore.state.compareId === entry.id ? '' : previewStore.state.compareId,
      })
    }

    /** 退出历史视图，回到当前这版结果。 */
    function exitHistoryView() {
      previewStore.set({ viewing: null, compareId: '', comparingOriginal: false })
    }

    /** 选一条历史来对比；再点同一条就是取消对比。 */
    function compareHistory(entry) {
      if (!entry) return
      previewStore.set({ compareId: previewStore.state.compareId === entry.id ? '' : entry.id })
    }

    /** 采用结果：写回草稿，并留住原文以便「退回」。 */
    function adoptPreview() {
      const state = previewStore.state
      if (state.phase !== 'ready') return
      // 采用前再核一次冲突：结果到手之后用户又改过输入，也不能覆盖。
      if (hasConflict(state)) return
      if (typeof previewStore.setDraft === 'function') previewStore.setDraft(state.result)
      previewStore.set({ phase: 'idle', adopted: true })
    }

    /**
     * 用某一版历史替换草稿。
     *
     * 和 adoptPreview 的区别：这里不要求 phase === 'ready'（历史是已经生成好的），
     * 也不看冲突 —— 用户是明确指着某一版说「就要它」，覆盖是有意的。
     * 写回后退出历史视图，卡片回到当前结果。
     */
    function adoptHistory(entry) {
      if (!entry || typeof entry.result !== 'string') return
      if (typeof previewStore.setDraft === 'function') previewStore.setDraft(entry.result)
      previewStore.set({ viewing: null, compareId: '', adopted: true })
    }

    /**
     * 判断当前草稿是否和「送去优化的那段原文」不一致。
     *
     * 结果到手那一刻先记一次（state.conflict），但用户可能在预览卡
     * 出现之后又改了输入框 —— 所以每次渲染都要按当前草稿重新算一遍。
     *
     * @param {object} state 预览状态
     * @param {string} [observed] 调用方刚观察到的草稿（比 store 里的更实时）
     */
    function hasConflict(state, observed) {
      const current = typeof observed === 'string'
        ? observed
        : (typeof previewStore.currentDraft === 'string'
            ? previewStore.currentDraft
            : (typeof previewStore.getDraft === 'function' ? previewStore.getDraft() : ''))
      const source = typeof state.source === 'string' ? state.source : ''
      if (typeof current !== 'string') return state.conflict === true
      if (current.trim() !== source.trim()) return true
      return state.conflict === true
    }

    /**
     * 放弃结果：草稿原样不动。
     *
     * 故意**不清 requestId**：它标的是「这一次请求」，runOptimize 收尾时靠
     * phase 已经变回 idle 认出「用户关掉了」，不会再把卡片写回来。
     * 清掉它反而会让那次请求在收尾时被当成「另一个请求」而多走一遍分支。
     */
    function discardPreview() {
      previewStore.set({
        phase: 'idle', result: '', conflict: false, adopted: false,
        streaming: false, revising: '', reasoning: '',
      })
    }

    /** 复制结果到剪贴板。传了 text 就复制那一份（历史版本），否则复制当前结果。 */
    async function copyPreview(text) {
      const target = typeof text === 'string' && text.length > 0 ? text : previewStore.state.result
      if (typeof target !== 'string' || target.length === 0) return
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(target)
        }
      } catch {
        /* 剪贴板不可用（无权限/非安全上下文）就算了，不打扰用户 */
      }
    }

    /** 用当前草稿再优化一次（换个说法再来一版）。 */
    async function reoptimizePreview() {
      const current = typeof previewStore.getDraft === 'function' ? previewStore.getDraft() : ''
      const source = typeof current === 'string' && current.trim().length > 0
        ? current.trim()
        : previewStore.state.source
      if (source.length === 0) return
      await runOptimize(source, previewStore.sessionId)
    }

    // ── 多入口 ────────────────────────────────────────────────────────────

    /*
     * 同一个优化动作现在有多个入口，全都落到 runOptimize()：
     *   输入框按钮（conversation.input.right）
     *   会话头按钮（conversation.session.header.actions）
     *   全局快捷键 Alt+O
     *   斜杠命令 /optimize（宿主的，结果进对话；这里只挂「裸调用」装饰）
     *
     * 为什么不在每个入口里各写一遍：入口不同，做的事完全一样 ——
     * 读当前草稿、送服务端、把结果摆进预览卡。多写一遍就多一处会跑偏的地方。
     */

    /**
     * 是否还有一份「已生成、没被采用」的结果等着用户处理。
     *
     * 用来判断 Alt+O 该「开始优化」还是「采用结果」：
     * 结果已经在预览卡里时，再按一次快捷键应该把它用上，而不是重新跑一遍。
     */
    function hasReadyPreview() {
      return previewStore.state.phase === 'ready'
    }

    /**
     * 采用当前预览结果，并保证草稿真的被写回。
     *
     * adoptPreview() 依赖按钮注入的 setDraft。按钮不在场时（比如用户从
     * 设置页回来、按钮还没挂载），setDraft 是 null —— 这时结果采用不了。
     * 这里退一步：把结果留在预览卡里，告诉调用方「先看一眼」。
     *
     * @returns {boolean} 是否真的写回了草稿
     */
    function adoptIfPossible() {
      if (hasConflict(previewStore.state)) return false
      if (typeof previewStore.setDraft !== 'function') return false
      adoptPreview()
      return true
    }

    /**
     * 全局快捷键 Alt+O。
     *
     * 为什么不用 ctx.shortcuts 声明：宿主的快捷键服务在 Web 端只放行
     * 「三个以上修饰键」或「primary+alt/shift」这类组合，纯 Alt+O 会被
     * 判为 unsupported-browser 直接抛错；而 Alt+O 正是这里要的键位。
     * 所以自己挂 document 监听，用 ctx.effect 管生命周期。
     *
     * 行为（按当前状态决定，同一个键不产生第二种含义）：
     *   预览卡里有结果 → 采用它
     *   草稿为空       → 什么都不做（不弹错，不打断输入）
     *   其余           → 优化当前草稿
     *
     * 在输入框里也生效：这是「对草稿动手」的动作，光标在哪不该影响它。
     * 但输入法组合中（composing）按下的键不算 —— 那是用户在打中文。
     */
    /**
     * 按下「优化」该做什么 —— 快捷键、斜杠命令、会话头按钮共用这一份判断。
     *
     * 三种状态各对应一个动作，同一个入口不产生第二种含义：
     *   有结果待采用 → 采用它
     *   正在生成中   → 什么都不做（别叠一次请求）
     *   草稿非空     → 优化它
     *   草稿为空     → 什么都不做
     *
     * @returns {boolean} 是否真的做了事（调用方据此决定要不要吞掉按键/命令）
     */
    function triggerOptimize() {
      const ready = hasReadyPreview()
      if (ready) return adoptIfPossible()

      const current = typeof previewStore.getDraft === 'function' ? previewStore.getDraft() : ''
      const text = typeof current === 'string' ? current.trim() : ''
      if (text.length === 0) return false
      if (previewStore.state.phase === 'running') return false
      void runOptimize(text, previewStore.sessionId)
      return true
    }

    function installShortcut(ctx) {
      if (typeof document === 'undefined') return undefined
      const onKeyDown = (event) => {
        if (event.defaultPrevented === true) return
        if (event.isComposing === true) return
        // 只认 Alt+O，不认 Ctrl/Shift/Meta 组合，避免和宿主自己的键位打架。
        if (event.altKey !== true) return
        if (event.ctrlKey === true || event.metaKey === true || event.shiftKey === true) return
        if (event.code !== 'KeyO' && event.key !== 'o' && event.key !== 'O') return

        // 无事可做时别吞掉这个键 —— 宿主或其他插件可能想用它。
        if (!canTrigger()) return
        event.preventDefault()
        triggerOptimize()
      }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
    }

    /** 此刻按「优化」有没有意义（决定快捷键要不要吞键）。 */
    function canTrigger() {
      if (hasReadyPreview()) return true
      const current = typeof previewStore.getDraft === 'function' ? previewStore.getDraft() : ''
      return typeof current === 'string' && current.trim().length > 0
    }

    /**
     * 斜杠命令 `/optimize` 的客户端装饰。
     *
     * 宿主半区的命令需要带参数（`/optimize 要改写的文字`），因为宿主拿不到输入框。
     * 但人在输入框里写好了草稿时，更自然的用法是光敲 `/optimize` 回车 —— 这条
     * 装饰就负责「裸调用」：宿主命令声明了 input，客户端装饰会在命令名单独出现时
     * 先被匹配到，于是 token 被吃掉、动作直接跑在当前草稿上。
     *
     * 带参数时装饰不生效，仍然走宿主命令本体（结果作为回执进对话）。
     * 用 decorate 而不是 register：同名 contribution 会和宿主命令冲突直接抛错。
     */
    function installCommandEntry(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['commandUi'], (scope) => {
        scope.effect(() => scope.commandUi.decorate({
          name: 'optimize',
          available: () => true,
          ui: {
            kind: 'action',
            run: () => { triggerOptimize() },
          },
        }), 'dsh-prompt-optimizer: /optimize decoration')
      })
    }

    /**
     * 会话头按钮：标题旁边那颗双星。
     *
     * 为什么放在会话头而不是再造一个输入框按钮：输入框按钮已经有了，
     * 这一颗是给「手已经在标题栏附近」的时候用的 —— 也顺便让这个功能
     * 在输入框被折叠/换布局时仍然摸得到。
     *
     * 它和输入框按钮共用 previewStore，所以状态天然一致：
     * 这边点开始，那边的按钮也会变成「取消」。
     */
    function HeaderOptimizeButton(props) {
      const draft = props.useInput((state) => state.draft)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const [preview, setPreview] = useState(previewStore.state)
      const busyRef = useRef(false)

      useEffect(() => {
        const unsubscribe = previewStore.subscribe(setPreview)
        return () => { unsubscribe() }
      }, [])

      // 预览卡要读写草稿，靠这里注入（输入框按钮可能没挂载）。
      useEffect(() => {
        previewStore.getDraft = () => (typeof draft === 'string' ? draft : '')
        previewStore.setDraft = (value) => {
          if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
            props.inputActions.setDraft(value)
          }
        }
        previewStore.sessionId = sessionId
      }, [draft, sessionId, props.inputActions])

      const text = typeof draft === 'string' ? draft : ''
      const empty = text.trim().length === 0
      const running = preview.phase === 'running'
      const ready = preview.phase === 'ready'

      const onClick = useCallback(() => {
        if (busyRef.current) return
        if (running) {
          const requestId = previewStore.state.requestId
          if (typeof requestId === 'string' && requestId.length > 0) {
            void abortOptimize(requestId)
          }
          return
        }
        if (ready) {
          adoptIfPossible()
          return
        }
        if (text.trim().length === 0) return
        busyRef.current = true
        void runOptimize(text, sessionId).finally(() => { busyRef.current = false })
      }, [running, ready, text, sessionId])

      const title = running
        ? '中止这次优化'
        : ready
          ? '用优化结果替换输入框里的内容'
          : empty
            ? '先在输入框里写下要优化的内容'
            : '优化提示词（Alt+O）'

      return h('span', { className: 'dsho-head-root' },
        h('style', null, HEAD_CSS),
        h('button', {
          type: 'button',
          className: 'dsho-head-btn',
          'data-state': running ? 'running' : (ready ? 'ready' : 'idle'),
          'aria-label': title,
          title,
          disabled: !running && !ready && empty,
          onClick,
        },
          h(SparkIcon, { spin: running }),
          // 有结果待处理时点一颗小圆点：不占地方，但一眼能看出「有东西等你」。
          ready ? h('span', { className: 'dsho-head-dot', 'aria-hidden': 'true' }) : null
        )
      )
    }

    /**
     * 输入框按钮：优化 / 取消 / 退回 三态。
     *
     *   optimize —— 默认态，空草稿时禁用。
     *   cancel   —— 优化进行中，点一下中止这次请求（真的停，不是等它跑完）。
     *   restore  —— 结果已被采用，点一下把草稿还原成优化前的原文。
     *
     * 优化结果不直接盖住草稿，先进预览卡，用户确认才写回。
     */
    function OptimizeButton(props) {
      // 只订阅 draft，无关状态变化不触发重渲染。
      const draft = props.useInput((state) => state.draft)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [preview, setPreview] = useState(previewStore.state)
      // busy 的同步锁：setBusy 是异步的，同一帧内的连点靠它挡住。
      const busyRef = useRef(false)
      const timerRef = useRef(undefined)

      useEffect(() => {
        const unsubscribe = previewStore.subscribe(setPreview)
        return () => { unsubscribe() }
      }, [])

      // 预览卡要读写草稿，跨槽位只能靠这里注入。
      useEffect(() => {
        previewStore.getDraft = () => (typeof draft === 'string' ? draft : '')
        previewStore.setDraft = (text) => {
          if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
            props.inputActions.setDraft(text)
          }
        }
        previewStore.sessionId = sessionId
      }, [draft, sessionId, props.inputActions])

      useEffect(() => () => {
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      }, [])

      const text = typeof draft === 'string' ? draft : ''
      const empty = text.trim().length === 0

      // 用户采用了结果之后又改了内容 → 「退回」不再成立，按钮切回「优化」。
      useEffect(() => {
        if (previewStore.state.adopted !== true) return
        const current = typeof draft === 'string' ? draft : ''
        // 等于刚写进去的结果 → 是本次 setDraft 生效，不是用户改动。
        if (current === previewStore.state.result) return
        previewStore.set({ adopted: false, result: '', original: '', phase: 'idle' })
      }, [draft, preview.adopted, preview.result])

      const showError = useCallback((message) => {
        setError(String(message || '优化失败'))
        if (timerRef.current !== undefined) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setError(null), 5000)
      }, [])

      /*
       * 发起一次优化。
       *
       * 不做「忙着就 return」：那会让第二次点击看起来毫无反应 —— 屏幕上还在
       * 长的是第一次的字，用户以为卡住了。允许再开一次更符合直觉；两次结果
       * 不会互相顶，因为 runOptimize 里每批事件都按 requestId 认领。
       */
      const run = useCallback(async () => {
        const raw = typeof draft === 'string' ? draft : ''
        if (raw.trim().length === 0) return

        busyRef.current = true
        previewStore.set({ phase: 'running' })
        setBusy(true)
        setError(null)
        try {
          const outcome = await runOptimize(raw, sessionId)
          if (outcome.stale === true) return
          if (outcome.aborted === true) return
          if (outcome.ok !== true) showError(outcome.error)
        } catch (err) {
          showError(err && err.message ? err.message : err)
        } finally {
          // 只有自己还是当前这一次时才松手：更晚发起的那次可能还在跑。
          if (previewStore.state.phase !== 'running') {
            busyRef.current = false
            setBusy(false)
          }
        }
      }, [draft, sessionId, showError])

      const cancel = useCallback(async () => {
        const requestId = previewStore.state.requestId
        if (typeof requestId !== 'string' || requestId.length === 0) return
        try {
          await abortOptimize(requestId)
        } catch {
          /* 中止请求本身失败就等它自己跑完 */
        }
      }, [])

      const restore = useCallback(() => {
        const original = previewStore.state.original
        if (typeof original !== 'string' || original.length === 0) return
        previewStore.set({ phase: 'idle', result: '', adopted: false, original: '' })
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
          props.inputActions.setDraft(original)
        }
      }, [props.inputActions])

      /*
       * 「忙」以共享状态为准，而不是本地 busy。
       *
       * 会话头按钮、Alt+O 也会发起优化，它们改的是 previewStore。只看本地
       * busy 的话，从别的入口开跑时这颗按钮还写着「优化」，点下去会再开一次。
       */
      const running = preview.phase === 'running' || busy
      const isRestore = preview.adopted === true
      const mode = running ? 'cancel' : isRestore ? 'restore' : 'optimize'
      const label = running ? '取消' : isRestore ? '退回' : '优化'
      const title = running
        ? '中止这次优化'
        : isRestore
          ? '撤销这次优化，恢复成优化前的内容'
          : empty
            ? '先在输入框里写下要优化的内容'
            : '把这段话改写成 DeepSeek Harness 能直接照做的提示词'

      return h('div', { className: 'dsho-root' },
        h('style', null, BUTTON_CSS),
        error === null ? null : h('div', { className: 'dsho-err', role: 'alert' }, error),
        h('button', {
          type: 'button',
          className: 'dsho-btn',
          'data-busy': running ? 'true' : 'false',
          'data-mode': mode,
          disabled: running ? false : (!isRestore && empty),
          onClick: () => {
            if (running) { void cancel(); return }
            if (isRestore) { restore(); return }
            void run()
          },
          'aria-label': running
            ? '取消优化'
            : isRestore ? '退回优化，恢复原文' : '优化提示词',
          title,
        },
          mode === 'cancel'
            ? h(StopIcon, null)
            : mode === 'restore' ? h(UndoIcon, null) : h(SparkIcon, { spin: running }),
          h('span', null, label)
        )
      )
    }

    // ── 设置页 ────────────────────────────────────────────────────────────

    function SettingsPage(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      // 本地编辑态：改动即时保存，但 UI 要先反映出来。
      const [draft, setDraft] = useState(null)

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const loaded = await readSettings(sessionId)
            if (!alive) return
            setData(loaded)
            setDraft(loaded.settings)
          } catch (err) {
            if (alive) setError(String(err && err.message ? err.message : err))
          }
        })()
        return () => { alive = false }
      }, [])

      /**
       * 免费通道连通性探测。
       *
       * 每次打开这一页先跑一次：发一句 "Hi"，收到回应才算通。
       * 这样"免费通道现在能不能用"是可见的，而不是等按下优化按钮才发现。
       *
       * 服务端一旦判定为「密钥无效」就不会再去撞那个端点了，
       * 这里拿到的会是缓存结论（cached: true）—— 界面上要据此说明原因，
       * 而不是让人以为每次打开都在失败。
       */
      const [probe, setProbe] = useState({ phase: 'testing' })
      const runProbe = useCallback(async (force) => {
        setProbe({ phase: 'testing' })
        try {
          const result = await probeFreeChannel(force === true)
          setProbe({
            phase: result.ok === true ? 'ok' : 'fail',
            ms: result.ms,
            model: result.model,
            reply: result.reply,
            error: result.error,
            kind: result.kind,
            cached: result.cached === true,
          })
        } catch (err) {
          setProbe({ phase: 'fail', error: String(err && err.message ? err.message : err) })
        }
      }, [])

      useEffect(() => { void runProbe(false) }, [runProbe])

      /**
       * 保存设置。
       *
       * 刻意**不设 busy**：写的是本地文件，毫秒级完成，不需要忙碌态。
       * 早先在这里 setBusy(true) 会让所有卡片套上 opacity:.5，保存完再恢复，
       * 视觉上就是切换时"闪一下"。只有保存失败才用状态文字提示。
       */
      const persist = useCallback(async (next) => {
        setDraft(next)
        setStatus(null)
        try {
          const saved = await postJson('/dsh-prompt-optimizer/settings', next)
          setData((previous) => (previous === null ? previous : { ...previous, settings: saved.settings }))
          setStatus({
            kind: saved.saved ? 'ok' : 'err',
            text: saved.saved ? '已保存' : '已应用，但写入文件失败，重启后可能不保留',
          })
        } catch (err) {
          setStatus({ kind: 'err', text: String(err && err.message ? err.message : err) })
        }
      }, [])

      if (error !== null) {
        return h('div', { className: 'dsho-page' },
          h('style', null, PAGE_CSS),
          h('div', { className: 'dsho-status', 'data-kind': 'err' }, `读取设置失败：${error}`)
        )
      }
      if (data === null || draft === null) {
        return h('div', { className: 'dsho-page' },
          h('style', null, PAGE_CSS),
          h('div', { className: 'dsho-status' }, '正在读取…')
        )
      }

      const styles = data.styles ?? []
      const models = data.models ?? []
      // 每个风格档配一个图标，卡片式选项才有辨识度。
      const STYLE_ICON = {
        brief: IconBrief,
        balanced: IconBalanced,
        detailed: IconDetailed,
        custom: IconCustom,
      }
      const styleOptions = styles
        .map((item) => ({
          id: item.id,
          label: item.label,
          summary: item.summary,
          // 长度上限直接印在卡片上，三档的差别一眼就能看到。
          // 卡片徽标用短版（bandBadge），完整公式在下面的「长度上限」一行里。
          badge: item.bandBadge ?? item.band,
          Icon: STYLE_ICON[item.id] ?? IconBalanced,
        }))
        .concat({
          id: 'custom',
          label: '自定义',
          summary: '完全自己写系统提示词',
          Icon: IconCustom,
        })
      const modelOptions = models.map((item) => ({
        value: `${item.provider}\u0000${item.model}`,
        label: item.name,
        tag: item.providerName ?? item.provider,
      }))
      const manualValue = draft.provider.length > 0 && draft.model.length > 0
        ? `${draft.provider}\u0000${draft.model}`
        : ''

      const currentStyle = styles.find((item) => item.id === draft.style)
      const resolved = data.resolved

      return h('div', { className: 'dsho-page' },
        h('style', null, PAGE_CSS),

        // 模型
        h('div', { className: 'dsho-sec' },
          h('div', { className: 'dsho-sec-title' }, '优化用的模型'),
          h('div', { className: 'dsho-sec-hint' },
            '自动：跟随当前对话正在使用的模型；手动：固定用一个模型；免费：优先走免费通道（需要自己配 DSH_FREE_CHANNEL_API_KEY，失效时自动回退到对话模型）。'),
          h(CardChoice, {
            value: draft.modelMode,
            // 免费通道放最左：它是"优先"的那个选项，也是大多数人该选的。
            options: [
              // 顺序就是推荐顺序：自动排第一 —— 它永远能用。
              // 免费通道要用户自己配密钥，不是开箱即用、也随时可能失效，
              // 把它标成「优先」会让新用户以为这是默认推荐，结果先撞一次失败再回退。
              { id: 'auto', label: '自动', summary: '跟随当前对话的模型，永远可用', Icon: IconAuto },
              {
                id: 'free',
                label: '免费通道',
                badge: '可能失效',
                summary: '你自己的端点，不消耗对话额度；失效时自动回退',
                Icon: IconFree,
              },
              { id: 'manual', label: '手动', summary: '固定指定一个模型', Icon: IconManual },
            ],
            onChange: (value) => { void persist({ ...draft, modelMode: value, freeChannelAsked: true }) },
          }),
          draft.modelMode === 'manual'
            ? h(Select, {
                value: manualValue,
                placeholder: models.length === 0 ? '没有可用模型' : '选择一个模型',
                options: modelOptions,
                onChange: (value) => {
                  const [provider, model] = value.split('\u0000')
                  void persist({ ...draft, provider, model })
                },
              })
            : draft.modelMode === 'free'
              ? h('div', { className: 'dsho-card dsho-card-auto' },
                  h('div', { className: 'dsho-sec-hint' },
                    `下一次优化将调用：免费通道 / ${data.freeChannel?.model ?? '默认模型'}`),
                  // 连通性探测：打开本页自动跑一次，也可以手动重测。
                  h('div', { className: 'dsho-probe' },
                    h('span', {
                      className: 'dsho-probe-dot',
                      'data-state': probe.phase,
                      'data-kind': probe.kind === 'auth' ? 'warn' : undefined,
                      'aria-hidden': 'true',
                    }),
                    h('span', {
                      className: 'dsho-probe-text',
                      'data-state': probe.phase,
                      // 密钥作废是「配置问题」，用警告色而不是报错红：
                      // 功能本身还能用（会自动回退），不该看着像崩了。
                      'data-kind': probe.kind === 'auth' ? 'warn' : undefined,
                    },
                      probe.phase === 'testing'
                        ? '正在测试免费通道连通性…'
                        : probe.phase === 'ok'
                          ? `连通正常（${probe.ms}ms，回复：${probe.reply}）`
                          : probe.error ?? '免费通道暂时不可用'),
                    h('button', {
                      type: 'button',
                      className: 'dsho-probe-retry',
                      disabled: probe.phase === 'testing',
                      onClick: () => { void runProbe(true) },
                      title: '发送一句 Hi，测试免费通道是否可用',
                    }, probe.phase === 'testing' ? '测试中…' : '重新测试')
                  ),
                  // 密钥无效是确定性问题：说清楚「不是你配错了」，并给出唯一出路。
                  probe.kind === 'auth'
                    ? h('div', { className: 'dsho-sec-hint', 'data-kind': 'warn' },
                        '你配置的免费通道密钥无效。请检查环境变量 DSH_FREE_CHANNEL_API_KEY 后重启 DSH。'
                        + '优化功能本身不受影响，会自动改用当前对话的模型。')
                    : null,
                  h('div', { className: 'dsho-sec-hint' },
                    '免费通道不可用时，自动回退到当前对话正在使用的模型，按钮不会因此失效。'),
                  data.lastUsed?.source === 'free'
                    ? h('div', { className: 'dsho-sec-hint' }, '上次优化走的是免费通道。')
                    : data.lastUsed?.freeError
                      ? h('div', { className: 'dsho-sec-hint', 'data-kind': 'warn' },
                          `上次免费通道不可用：${data.lastUsed.freeError}（已回退到对话模型）`)
                      : null
                )
              : h('div', { className: 'dsho-card' },
                  h('div', { className: 'dsho-sec-hint' },
                    resolved === undefined || resolved === null
                      ? '还没取到当前对话的模型。先在对话里发一条消息，这里就会跟上。'
                      : `下一次优化将调用：${resolved.provider} / ${resolved.model}`),
                  resolved === undefined || resolved === null
                    ? null
                    : h('div', { className: 'dsho-sec-hint' },
                        `来源：${SOURCE_LABEL[resolved.source] ?? resolved.source}`),
                  data.lastUsed === undefined || data.lastUsed === null
                    ? null
                    : h('div', { className: 'dsho-sec-hint' },
                        `上次实际调用：${data.lastUsed.provider} / ${data.lastUsed.model}`
                        + `（${SOURCE_LABEL[data.lastUsed.source] ?? data.lastUsed.source}，`
                        + `力度「${data.lastUsed.style}」）`)
                )
        ),

        // 风格
        h('div', { className: 'dsho-sec' },
          h('div', { className: 'dsho-sec-title' }, '改写力度'),
          h('div', { className: 'dsho-sec-hint' },
            '三档的差别在长度上限、可补充的内容和禁止项上；不改变你的意图，规则已按 DSH 场景适配（@ 文件引用、可执行动作、验收口径）。'),
          h(CardChoice, {
            value: draft.style,
            options: styleOptions,
            onChange: (value) => { void persist({ ...draft, style: value }) },
          }),
          draft.style === 'custom'
            ? h('textarea', {
                className: 'dsho-textarea',
                value: draft.customPrompt,
                placeholder: '写你自己的系统提示词。留空则使用「均衡」档。',
                spellCheck: false,
                onChange: (event) => setDraft({ ...draft, customPrompt: event.target.value }),
                onBlur: (event) => { void persist({ ...draft, customPrompt: event.target.value }) },
              })
            : h('div', { className: 'dsho-card' },
                h('div', {
                  // key 跟着档位变，节点才会重建，淡入动画才会重放一次。
                  key: `summary-${draft.style}`,
                  className: 'dsho-sec-hint dsho-fade',
                }, currentStyle === undefined ? '' : currentStyle.summary),
                currentStyle !== undefined && currentStyle.scope !== undefined
                  ? h('div', {
                    key: `scope-${draft.style}`,
                    className: 'dsho-sec-hint dsho-fade',
                  }, `会做什么：${currentStyle.scope}`)
                  : null,
                currentStyle !== undefined && currentStyle.forbid !== undefined
                  ? h('div', {
                    key: `forbid-${draft.style}`,
                    className: 'dsho-sec-hint dsho-fade',
                  }, `不会做什么：${currentStyle.forbid}`)
                  : null,
                currentStyle !== undefined && currentStyle.band !== undefined
                  ? h('div', {
                    key: `band-${draft.style}`,
                    className: 'dsho-sec-hint dsho-fade',
                  }, `长度上限：${currentStyle.band}`)
                  : null,
                h('div', {
                  key: `prompt-${draft.style}`,
                  className: 'dsho-preview dsho-fade',
                }, currentStyle === undefined ? '' : currentStyle.prompt)
              )
        ),

        status === null
          ? null
          : h('div', { className: 'dsho-status', 'data-kind': status.kind }, status.text)
      )
    }

    // ── 首次安装的免费通道询问 ────────────────────────────────────────────

    /**
     * 装好插件后问一次：要不要开启免费通道。
     *
     * 只问一次 —— 服务端把 `freeChannelAsked` 写进设置，问过就不再出现。
     * 不自动消失：这是个需要用户表态的选择，自动消失等于替他做了决定。
     */
    function FreeChannelPrompt() {
      // loading → 还没读到设置；ask → 要问；hidden → 不问
      const [phase, setPhase] = useState('loading')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const settings = await readSettings()
            if (!alive) return
            setPhase(settings?.settings?.freeChannelAsked === true ? 'hidden' : 'ask')
          } catch {
            if (alive) setPhase('hidden')
          }
        })()
        return () => { alive = false }
      }, [])

      const decide = useCallback(async (enable) => {
        setBusy(true)
        try {
          await postJson('/dsh-prompt-optimizer/settings', enable
            // 选择开启就是切到「免费通道」这个模型选项，不再有单独的开关。
            ? { modelMode: 'free', freeChannelAsked: true }
            : { freeChannelAsked: true })
        } catch {
          /* 保存失败也别让浮层一直挡着 */
        } finally {
          setBusy(false)
          setPhase('hidden')
        }
      }, [])

      if (phase !== 'ask') return null

      return h('div', {
        className: 'dsho-toast',
        role: 'dialog',
        'aria-label': '开启免费通道',
      },
        // 样式必须由这个组件自己注入：它渲染在 shell.overlay，拿不到设置页的 <style>。
        h('style', null, TOAST_CSS),
        h('div', { className: 'dsho-toast-title' }, '开启免费通道？'),
        h('div', { className: 'dsho-toast-body' },
          '提示词优化可以走一个免费额度端点，不消耗你的对话额度。'
          + '它需要你自己配一把 API Key（环境变量 DSH_FREE_CHANNEL_API_KEY）；'
          + '没配或不可用时会自动切回当前对话使用的模型，不影响使用。'),
        h('div', { className: 'dsho-toast-actions' },
          h('button', {
            type: 'button',
            className: 'dsho-toast-btn',
            disabled: busy,
            onClick: () => { void decide(false) },
          }, '暂不开启'),
          h('button', {
            type: 'button',
            className: 'dsho-toast-btn',
            'data-primary': 'true',
            disabled: busy,
            onClick: () => { void decide(true) },
          }, '开启')
        )
      )
    }

    // ── 预览卡 ────────────────────────────────────────────────────────────

    /**
     * 把混进正文里的思考段剥掉。
     *
     * 模型有两条通道：reasoning（思考）和 text（正文）。规矩的模型只把正文
     * 放进 text，但实测有的模型会把「这一步该怎么做」一起塞进正文 ——
     * 于是结果框里躺着模型的草稿纸，用户拿到的不是能发给 DSH 的提示词。
     *
     * 这里只做一件事：把**与 reasoning 完全相同的整段文字**从正文里摘掉。
     * 不做模糊匹配 —— 提示词里出现和思考相似的词很正常，删错比留着更糟。
     * 判据因此很保守：整行相等、且那一行足够长（短句到处都有，不能当证据）。
     *
     * @param {string} text 正文
     * @param {string} reasoning 思考过程
     * @returns {string} 去掉重复段后的正文
     */
    function stripReasoning(text, reasoning) {
      const body = typeof text === 'string' ? text : ''
      const think = typeof reasoning === 'string' ? reasoning : ''
      if (body.length === 0 || think.length === 0) return body

      const thinkLines = new Set(
        think.split('\n').map((line) => line.trim()).filter((line) => line.length >= 8),
      )
      if (thinkLines.size === 0) return body

      /*
       * 只在「思考明显在复述正文」时才剥。
       *
       * 判据是重合度：正文里有几行能在思考里找到。零星一行重合是巧合 ——
       * 思考里常会先写下「目标：更新 README。」这样的提纲，正文里也这么写，
       * 那是用户要的东西，不是漏出来的思考。删掉它等于删掉正文。
       *
       * 真正漏出来的时候是成段重合：思考把整份正文都过了一遍。
       * 所以要求「重合行占正文可剥行的多数」才动手。
       */
      const bodyLines = body.split('\n')
      const candidates = bodyLines.filter((line) => line.trim().length >= 8)
      if (candidates.length === 0) return body
      const matched = candidates.filter((line) => thinkLines.has(line.trim())).length
      /*
       * 两种才算漏出来的思考，其余一律不动：
       *
       *   a) 这一行很长（≥20 字）而且思考里也有 —— 一整句思考原样出现在正文里，
       *      基本不可能是巧合。漏出来的典型样子就是这样。
       *   b) 正文大多数行都能在思考里找到 —— 整份正文被思考复述过一遍。
       *
       * 短行重合不算：「目标：更新 README。」这种提纲句，思考里会写，正文里
       * 用户也要写。把它当漏出来的思考删掉，删的是正文本身。
       */
      const echoWhole = matched * 2 > candidates.length
      const leaked = (line) => {
        const trimmed = line.trim()
        if (trimmed.length < 8) return false
        if (!thinkLines.has(trimmed)) return false
        return trimmed.length >= 20 || echoWhole
      }
      if (!candidates.some(leaked)) return body

      const kept = bodyLines.filter((line) => !leaked(line))
      const stripped = kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
      // 全被剥光说明判错了 —— 宁可原样给出，也不要交一张空白卡片。
      return stripped.length === 0 ? body : stripped
    }

    /**
     * 优化结果预览卡，挂在输入框上方的 conversation.input.dock。
     *
     * 结果不直接盖住草稿 —— 先摆在这里，用户看清了再决定：
     *   替换草稿 —— 采用结果（冲突时禁用，避免覆盖ta刚写的内容）
     *   复制     —— 结果进剪贴板，草稿不动
     *   重新优化 —— 用当前草稿再来一版
     *   放弃     —— 关掉这张卡，草稿原样不动
     *
     * 结果区是**整张预览卡的一部分**：卡片本身就是一个可缩放的窗口。
     * 位置永远在输入框上方，不提供位移交互；
     * 宽由卡片左右两条边缘手柄调，高由卡片上沿那条横向手柄调，
     * 两条边互不影响；手柄平时隐藏，鼠标移上去或正在拖时才显现。
     * 大小会记住（localStorage），下次打开还是这个尺寸。
     */
    function PreviewCard(props) {
      const [state, setState] = useState(previewStore.state)
      // 草稿可能随时被用户改，预览卡要跟着知道「现在还冲突吗」。
      const draft = typeof props.useInput === 'function'
        ? props.useInput((input) => input.draft)
        : ''
      const [draftTick, setDraftTick] = useState(0)
      // 卡片高度：用户拖过就用用户的值；没拖过保持自适应（null）。
      const [height, setHeight] = useState(readPreviewHeight())
      // 卡片宽度：左右两侧各扩出多少 px；{left:0,right:0} = 未调整。
      const [insets, setInsets] = useState(readPreviewInsets())
      // 正在拖动时把手柄点亮（平时是隐藏的）。
      const [resizing, setResizing] = useState(false)
      // 历史列表是否展开（默认收起，不占地方）。
      const [historyOpen, setHistoryOpen] = useState(false)
      /*
       * 思考过程默认收起。
       *
       * 实测一次优化能推 500+ 帧 reasoning（几千字），而结果正文只有几十字。
       * 展开着摆的话，卡片里是「一大坨草稿纸 + 一小段结果」上下两团，
       * 用户根本分不清哪一版是要用的 —— 这正是「出现两版」的来源。
       * 默认只留一行「思考过程 · N 字」，想看再点开。
       */
      const [reasoningOpen, setReasoningOpen] = useState(false)
      const frameRef = useRef(null)
      const dragRef = useRef(null)
      const edgeDragRef = useRef(null)
      const dockRef = useRef(null)
      // 对比视图两栏的正文容器：逐行拉等高时要用它们拿子节点。
      const leftBodyRef = useRef(null)
      const rightBodyRef = useRef(null)
      // 用户「想要」的高度（只受 720 上限约束）。视口变小时显示高度会被夹住，
      // 但这里记着的值不变，窗口恢复后卡片还能长回去。
      const desiredHeightRef = useRef(null)

      /**
       * 量一下预览卡（卡片本体）有多宽。
       *
       * 收窄时不能把卡片缩到看不见，所以上限要按容器宽度算。
       * 量不到就返回 undefined，交给 clamp 用兜底值。
       */
      const measureContainerWidth = useCallback(() => {
        const dock = dockRef.current
        if (!dock || typeof dock.getBoundingClientRect !== 'function') return undefined
        const width = dock.getBoundingClientRect().width
        return Number.isFinite(width) && width > 0 ? width : undefined
      }, [])

      useEffect(() => {
        const unsubscribe = previewStore.subscribe(setState)
        return () => { unsubscribe() }
      }, [])

      useEffect(() => {
        setDraftTick((n) => n + 1)
      }, [draft])

      /*
       * Esc 收起历史浮层。
       *
       * 定高之后它会盖住正文 —— 鼠标在别处时想关掉只能去点那个「历史 N」，
       * 而这时候按钮上还顶着浮层。Esc 是这种下拉层最该有的退出口。
       *
       * 展开时才挂监听，收起就摘掉；处理器里再按 ref 核一次状态，
       * 这样即使某个渲染批次留下的旧监听没来得及摘，也不会替宿主吞掉 Esc。
       */
      const historyOpenRef = useRef(false)
      historyOpenRef.current = historyOpen
      useEffect(() => {
        if (!historyOpen) return undefined
        if (typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return
          if (event.isComposing === true) return
          // 旧监听兜底：列表已经收起，这个 Esc 不归我管。
          if (historyOpenRef.current !== true) return
          event.preventDefault()
          setHistoryOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [historyOpen])

      /*
       * 点别处收起历史浮层。
       *
       * 它是盖在正文上的下拉层，不是页面的一部分 —— 用户点正文、点按钮、
       * 点聊天区任何一处，意思都是「我看完了」。只认浮层自己和那个开关按钮，
       * 点它们不算「别处」（否则点一下开关会先被关掉再被打开，看着像失灵）。
       */
      useEffect(() => {
        if (!historyOpen) return undefined
        if (typeof document === 'undefined') return undefined
        const onDown = (event) => {
          if (!event || !event.target) return
          if (historyOpenRef.current !== true) return
          const target = event.target
          if (typeof target.closest === 'function') {
            if (target.closest('.dsho-dock-history')) return
            if (target.closest('.dsho-dock-history-btn')) return
          }
          setHistoryOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => { document.removeEventListener('mousedown', onDown) }
      }, [historyOpen])

      // 挂载时先夹一次：上次记住的高度可能比现在的窗口还高（换了显示器、窗口变小）。
      useEffect(() => {
        if (height === null) return
        if (desiredHeightRef.current === null) desiredHeightRef.current = height
        setHeight(clampPreviewHeight(desiredHeightRef.current, measureMaxPreviewHeight(dockRef.current)))
        // 只在挂载时跑一次；height 的变化由 applyHeight 自己处理。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])


      /**
       * 应用卡片高度。
       *
       * 高度直接定在卡片上（内联 height），正文区作为 flex 子项自动占满剩余空间，
       * 内容多了在正文区内部滚动，头尾始终可见。
       */
      const applyHeight = useCallback((next) => {
        const raw = Number(next)
        // 用户还没调过时（height === null）拿默认值当基准，别把 null 当 0 算。
        const base = Number.isFinite(raw) ? raw : PREVIEW_DEFAULT_HEIGHT
        // desired = 用户想要的高度（只受 720 上限约束），记下来，窗口变大后还能长回去。
        const desired = clampPreviewHeight(base)
        desiredHeightRef.current = desired
        writePreviewHeight(desired)
        // shown = 这一刻真正给出去的高度：再按「视口还剩多少」夹一次，
        // 免得卡片上沿越过屏幕顶部（卡片贴底，高度就是往上长的量）。
        const shown = clampPreviewHeight(desired, measureMaxPreviewHeight(dockRef.current))
        setHeight(shown)
        return shown
      }, [])

      /**
       * 让并排两栏的每一行等高，并让两栏同步滚动。
       *
       * 两栏是各自独立的滚动框。同一行文字在两栏里长度不同，换行次数就不同 ——
       * 左边折成三行、右边只有一行时，两栏从那行起行号就错开了，用户看到的
       * 「左边第 3 行 vs 右边第 3 行」根本不是同一处改动。
       *
       * 所以渲染完按对逐行量高度，取两边最大值写死到两侧行盒上；高度一致，
       * 两栏的行就永远对齐。量不到（没有 DOM、节点还没提交）就原样返回。
       */
      const alignCompareRows = useCallback(() => {
        const leftBody = leftBodyRef.current
        const rightBody = rightBodyRef.current
        if (!leftBody || !rightBody) return
        const leftRows = leftBody.children
        const rightRows = rightBody.children
        if (!leftRows || !rightRows) return
        const count = Math.min(leftRows.length, rightRows.length)
        if (count === 0) return
        // 先清掉上一次写死的高度，否则量到的是上一轮的结果，越叠越高。
        for (let i = 0; i < count; i += 1) {
          leftRows[i].style.height = ''
          rightRows[i].style.height = ''
        }
        // 再统一按这一轮的真实内容定高度。
        for (let i = 0; i < count; i += 1) {
          const leftHeight = leftRows[i].getBoundingClientRect
            ? leftRows[i].getBoundingClientRect().height
            : 0
          const rightHeight = rightRows[i].getBoundingClientRect
            ? rightRows[i].getBoundingClientRect().height
            : 0
          const tallest = Math.max(leftHeight, rightHeight)
          if (!Number.isFinite(tallest) || tallest <= 0) continue
          leftRows[i].style.height = tallest + 'px'
          rightRows[i].style.height = tallest + 'px'
        }
      }, [])

      /*
       * 对比视图一出现（或内容变了），就把两栏对齐一次。
       *
       * 依赖里放的是「会不会出现两栏」和「正文有多长」，不是 pair 对象本身 ——
       * pair 每次渲染都是新对象，放进去会每帧都跑一遍对齐。
       */
      useEffect(() => {
        if (state.phase !== 'ready' && state.phase !== 'running') return undefined
        const run = () => { alignCompareRows() }
        if (typeof requestAnimationFrame === 'function') {
          const id = requestAnimationFrame(run)
          return () => {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
          }
        }
        run()
        return undefined
      }, [
        alignCompareRows,
        state.phase,
        state.viewing,
        state.compareId,
        state.comparingOriginal,
        typeof state.result === 'string' ? state.result.length : 0,
      ])

      /*
       * 窗口宽度一变，同样的字重新换行，行高全变了 —— 得重新对一次。
       *
       * 字体异步加载完也会改变行高（中文回退字体和正文字体的度量不一样），
       * 所以顺带等一次 fonts.ready；拿不到就跳过，不影响主流程。
       */
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onResize = () => { alignCompareRows() }
        window.addEventListener('resize', onResize)
        let cancelled = false
        // document 只在浏览器里有；测试桩没有 document，直接跳过字体那一步。
        const fonts = typeof document !== 'undefined' && document ? document.fonts : undefined
        if (fonts && typeof fonts.ready === 'object' && typeof fonts.ready.then === 'function') {
          fonts.ready.then(() => { if (!cancelled) alignCompareRows() }).catch(() => {})
        }
        return () => {
          cancelled = true
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', onResize)
        }
      }, [alignCompareRows])

      /**
       * 两栏同步滚动。
       *
       * 行高度已经对齐了，但两个滚动框是独立的：滚左边，右边还停在原处，
       * 「同一行」就又看不见了。这里把一侧的 scrollTop 抄给另一侧。
       *
       * 不需要加锁：抄过去之后两边 scrollTop 相等，对方收到 scroll 事件时
       * 差值是 0，直接返回，不会来回弹。浮点误差用 1px 容差挡掉。
       */
      const onColumnScroll = useCallback((event) => {
        const target = event && event.currentTarget
        if (!target) return
        const other = target === leftBodyRef.current ? rightBodyRef.current : leftBodyRef.current
        if (!other) return
        const from = Number(target.scrollTop) || 0
        const to = Number(other.scrollTop) || 0
        if (Math.abs(to - from) < 1) return
        other.scrollTop = from
      }, [])

      /**
       * 视口一变（窗口缩小、开发者工具展开、浏览器缩放），把卡片重新夹进可用空间。
       *
       * 用户拖出来的高度记在 desiredHeightRef 里，这里只改「显示多高」，
       * 不动用户的选择 —— 窗口恢复大小后卡片自动长回原来的高度。
       */
      const reflowHeight = useCallback(() => {
        if (height === null) return
        const desired = desiredHeightRef.current === null ? height : desiredHeightRef.current
        setHeight(clampPreviewHeight(desired, measureMaxPreviewHeight(dockRef.current)))
      }, [height])

      // 视口尺寸变了也要重夹，否则窗口一缩小卡片上沿又跑出屏幕。
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onResize = () => { reflowHeight() }
        window.addEventListener('resize', onResize)
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', onResize)
        }
      }, [reflowHeight])

      /** 拖动中：按指针位置算出目标高度。 */
      const onGripPointerDown = useCallback((event) => {
        if (event.button !== undefined && event.button !== 0) return
        const dock = dockRef.current
        if (!dock || typeof dock.getBoundingClientRect !== 'function') return
        const rect = dock.getBoundingClientRect()
        // 手柄在卡片上沿：往下拖 = 上沿下移 = 变矮，往上拖 = 变高。
        dragRef.current = { startY: event.clientY, startHeight: rect.height }
        setResizing(true)
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const move = (moveEvent) => {
          const drag = dragRef.current
          if (!drag) return
          applyHeight(drag.startHeight - (moveEvent.clientY - drag.startY))
        }
        const stop = () => {
          dragRef.current = null
          setResizing(false)
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
          }
        }
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', stop)
          window.addEventListener('pointercancel', stop)
        }
      }, [applyHeight])

      /** 键盘微调：上下方向键 24px 一档。手柄在上沿，所以 ↑ = 变高，↓ = 变矮。 */
      const onGripKeyDown = useCallback((event) => {
        /*
         * 基准取「用户想要的高度」，不是「当前显示的高度」。
         *
         * 窗口矮的时候显示高度会被视口夹住（比如想 720、实际只显示 644），
         * 这时如果拿显示高度当基准，怎么按都停在 644 —— 键盘就卡死了。
         * 拿想要的高度当基准，按上去仍然是 720，窗口恢复后卡片自然长回去。
         */
        const base = desiredHeightRef.current !== null
          ? desiredHeightRef.current
          : (height === null ? PREVIEW_DEFAULT_HEIGHT : height)
        if (event.key === 'ArrowUp') {
          applyHeight(base + 24)
          if (typeof event.preventDefault === 'function') event.preventDefault()
        } else if (event.key === 'ArrowDown') {
          applyHeight(base - 24)
          if (typeof event.preventDefault === 'function') event.preventDefault()
        }
      }, [applyHeight, height])

      /**
       * 量出这一侧能扩出多少像素。
       *
       * 往外拖受视口剩余空间约束（拖出屏幕会让宿主冒出横向滚动条），
       * 往里拖最多收掉容器宽度的 PREVIEW_MAX_NARROW_RATIO（别把卡片拖没了）。
       */
      const measureInsetLimits = useCallback((side) => {
        const dock = dockRef.current
        const containerWidth = measureContainerWidth()
        const narrowLimit = Number.isFinite(containerWidth) && containerWidth > 0
          ? -(containerWidth * PREVIEW_MAX_NARROW_RATIO)
          : PREVIEW_PERSIST_MIN_INSET
        if (!dock || typeof dock.getBoundingClientRect !== 'function') {
          return { min: narrowLimit, max: PREVIEW_MAX_EXPAND_PX }
        }
        const rect = dock.getBoundingClientRect()
        const viewportWidth = typeof window !== 'undefined' ? Number(window.innerWidth) : NaN
        let room = PREVIEW_MAX_EXPAND_PX
        if (side === 'left') {
          room = rect.left
        } else if (Number.isFinite(viewportWidth) && viewportWidth > 0) {
          room = viewportWidth - rect.right
        }
        // 留 12px 余量，别紧贴视口边缘。
        const max = Math.max(0, Math.min(PREVIEW_MAX_EXPAND_PX, Math.floor(room - 12)))
        return { min: narrowLimit, max }
      }, [measureContainerWidth])

      /**
       * 应用左右扩出量。
       *
       * 只改被拖的那一侧 —— 另一侧的数值原样带回，所以左右互不影响。
       * 同时更新 state 与持久化偏好。
       */
      const applyInset = useCallback((side, next) => {
        // 上限跟视口剩余空间有关，所以每次先量一次再夹。
        const value = clampPreviewInset(next, measureInsetLimits(side))
        setInsets((current) => {
          const merged = {
            left: side === 'left' ? value : (current ? current.left : 0),
            right: side === 'right' ? value : (current ? current.right : 0),
          }
          writePreviewInsets(merged)
          return merged
        })
        return value
      }, [measureInsetLimits])

      /**
       * 拖动左/右边缘手柄改宽度。
       *
       * 左边缘：往右拖 = 收窄（扩出量变小），往左拖 = 拉宽。
       * 右边缘：往左拖 = 收窄，往右拖 = 拉宽。
       * 用起始扩出量 + 指针位移计算，拖动跟手。
       */
      const onEdgePointerDown = useCallback((side) => (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const dock = dockRef.current
        if (!dock || typeof dock.getBoundingClientRect !== 'function') return
        const rect = dock.getBoundingClientRect()
        const startX = event.clientX
        const startInset = side === 'left' ? insets.left : insets.right
        edgeDragRef.current = { side, startX, startInset }
        setResizing(true)
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const move = (moveEvent) => {
          const drag = edgeDragRef.current
          if (!drag) return
          const delta = moveEvent.clientX - drag.startX
          // 左边缘往右拖是收窄（inset 变小），右边缘往右拖是拉宽（inset 变大）。
          const signed = drag.side === 'left' ? -delta : delta
          applyInset(drag.side, drag.startInset + signed)
        }
        const stop = () => {
          edgeDragRef.current = null
          setResizing(false)
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
          }
        }
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', stop)
          window.addEventListener('pointercancel', stop)
        }
      }, [applyInset, insets.left, insets.right])

      /** 键盘微调宽度：左右方向键 24px 一档，只动被聚焦的那一侧。 */
      const onEdgeKeyDown = useCallback((side) => (event) => {
        const base = side === 'left' ? insets.left : insets.right
        if (event.key === 'ArrowLeft') {
          applyInset(side, base - 24)
          if (typeof event.preventDefault === 'function') event.preventDefault()
        } else if (event.key === 'ArrowRight') {
          applyInset(side, base + 24)
          if (typeof event.preventDefault === 'function') event.preventDefault()
        }
      }, [applyInset, insets.left, insets.right])

      // 流式过程中也要显示预览卡：用户在等的时候得看见字在长。
      if (state.phase !== 'ready' && state.phase !== 'running') return null

      /*
       * 卡片只显示在发起它的那个对话里。
       *
       * previewStore 是模块级单例，一个标签页只有一份；界面里却能同时开着
       * 好几个对话。不按归属过滤的话，在 A 里点优化、切到 B，B 的输入框上方
       * 照样挂着 A 的结果 —— 用户会以为那是 B 的。
       *
       * 没记归属（老状态、或者拿不到 sessionId）时不拦：宁可显示，也不要
       * 因为拿不到 id 就把用户的结果藏起来。
       */
      const owner = typeof state.ownerSessionId === 'string' ? state.ownerSessionId : ''
      const mine = typeof props.sessionId === 'string' ? props.sessionId : ''
      if (owner.length > 0 && mine.length > 0 && owner !== mine) return null

      const meta = state.meta || {}
      const metaParts = []
      if (meta.model) metaParts.push(meta.model)
      if (meta.style) metaParts.push(meta.style)
      if (meta.adjusted === 'trimmed') metaParts.push('已按档位上限收敛')
      else if (meta.adjusted === 'expanded') metaParts.push('已补齐到档位下限')
      if (meta.recovered) metaParts.push('从过度扩写中拉回')
      // 换稿期间说清楚在干什么：这是「结果突然变了」不再显得莫名其妙的关键。
      if (state.streaming === true) metaParts.push(state.revising || '生成中…')

      /*
       * 用量与用时：模型/档位之外，再告诉用户「花了多少」。
       *
       * 拿不到的数据不写 0 —— 写「未提供」，免得让人以为真没用 token。
       */
      const usage = state.usage
      const usageParts = []
      if (typeof state.elapsedMs === 'number' && state.elapsedMs >= 0) {
        usageParts.push(`${(state.elapsedMs / 1000).toFixed(1)}s`)
      }
      if (usage !== null && usage !== undefined) {
        const total = typeof usage.totalTokens === 'number'
          ? usage.totalTokens
          : (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
              ? usage.inputTokens + usage.outputTokens
              : null)
        if (total !== null) usageParts.push(`${total} token`)
        else usageParts.push('token 未提供')
      }
      const charCount = typeof state.result === 'string' ? state.result.length : 0
      if (charCount > 0) usageParts.push(`${charCount} 字`)

      // 按当前草稿实时判断，避免结果到手后用户又改输入被覆盖。
      const conflict = hasConflict(state, typeof draft === 'string' ? draft : undefined)

      /*
       * 这一卡显示什么正文，有三种情况：
       *   1. 正常 —— 当前这次的结果；
       *   2. 看历史 —— 用户从列表里点了一版，正文换成那一版，顶部挂一条横幅；
       *   3. 对比 —— 选了另一版，左右并排，改动行标色。
       * 三种都只是「换显示」，不动当前结果本身：退出历史视图就回到 1。
       */
      const history = Array.isArray(state.history) ? state.history : []
      const viewing = state.viewing && typeof state.viewing === 'object' ? state.viewing : null
      const shownText = viewing
        ? viewing.result
        : stripReasoning(state.result, state.reasoning)
      const compareEntry = viewing && state.compareId
        ? history.find((item) => item.id === state.compareId) || null
        : null
      const comparing = !!(viewing && compareEntry && compareEntry.id !== viewing.id)

      /*
       * 「对比原文」：结果 vs 用户自己写的那句。
       *
       * 用户最常问的是「它替我改了哪些字」，而不是「第三版和第四版差在哪」。
       * 历史对比只在看历史时才成立，这个在正常视图下就该可用，所以两条路
       * 分开判断、共用同一套两栏渲染。
       */
      const canCompareOriginal = !viewing
        && state.phase === 'ready'
        && typeof state.original === 'string'
        && state.original.trim().length > 0
        && typeof shownText === 'string'
        && shownText.trim().length > 0
        && state.original.trim() !== shownText.trim()
      const comparingOriginal = state.comparingOriginal === true && canCompareOriginal

      // 两栏视图的统一描述：谁也不会同时成立（一个是看历史，一个是看当前结果）。
      const pair = comparing
        ? {
            leftTitle: `对比基准 · ${formatHistoryTime(compareEntry.at)}`,
            rightTitle: `正在看 · ${formatHistoryTime(viewing.at)}`,
            diff: getDiff(compareEntry.result, viewing.result),
          }
        : comparingOriginal
          ? { leftTitle: '原文', rightTitle: '优化结果', diff: getDiff(state.original, shownText) }
          : null

      /*
       * 宽度：左右两侧各扩出多少 px；高度：整张卡片多高。
       *
       * 宽度两边都为 0 时就是原来的全宽状态，什么都不加（保持原有观感）。
       * 只要动过一侧，就用「宽度 + 左右 margin」把**整张卡片**撑出去：
       *   width: calc(100% + left + right)  —— 卡片总宽
       *   margin-left: -left                 —— 左边缘往外让出 left px
       *   margin-right: -right               —— 右边缘往外让出 right px
       * 负的扩出量（往里收窄）就是负 margin，卡片自然变窄。
       *
       * 高度直接定在卡片上（height），正文区作为 flex 子项自动占满剩余空间，
       * 内容多了在正文区内部滚动，标题和动作按钮始终可见。
       */
      const widthAdjusted = insets.left !== 0 || insets.right !== 0
      const heightAdjusted = height !== null
      const dockStyle = {
        ...(widthAdjusted
          ? {
              width: `calc(100% + ${insets.left}px + ${insets.right}px)`,
              marginLeft: `${-insets.left}px`,
              marginRight: `${-insets.right}px`,
            }
          : {}),
        ...(heightAdjusted ? { height: `${height}px` } : {}),
      }

      return h('div', {
        className: 'dsho-dock',
        ref: dockRef,
        style: Object.keys(dockStyle).length === 0 ? undefined : dockStyle,
        'data-height-adjusted': heightAdjusted ? 'true' : 'false',
        'data-resizing': resizing ? 'true' : 'false',
      },
        h('style', null, PREVIEW_CSS),
        // 高度手柄：卡片**上沿**的一条横条，浮在卡片上方（平时隐藏）。
        h('div', {
          className: 'dsho-dock-grip',
          role: 'separator',
          tabIndex: 0,
          'aria-label': '拖动调整结果卡片高度，或用上下方向键微调',
          title: '拖动调整高度（方向键微调）',
          onPointerDown: onGripPointerDown,
          onKeyDown: onGripKeyDown,
        }, h(ResizeGripIcon)),
        // 左边缘：往外拖把卡片拉宽，往里拖把卡片收窄。
        h('div', {
          className: 'dsho-dock-edge',
          'data-side': 'left',
          role: 'separator',
          tabIndex: 0,
          'aria-label': '拖动左边缘调整结果卡片宽度，或用左右方向键微调',
          title: '拖动左边缘调整宽度（方向键微调）',
          onPointerDown: onEdgePointerDown('left'),
          onKeyDown: onEdgeKeyDown('left'),
        }, h(EdgeLeftIcon)),
        // 右边缘：同理，与左边互不影响。
        h('div', {
          className: 'dsho-dock-edge',
          'data-side': 'right',
          role: 'separator',
          tabIndex: 0,
          'aria-label': '拖动右边缘调整结果卡片宽度，或用左右方向键微调',
          title: '拖动右边缘调整宽度（方向键微调）',
          onPointerDown: onEdgePointerDown('right'),
          onKeyDown: onEdgeKeyDown('right'),
        }, h(EdgeRightIcon)),
        h('div', { className: 'dsho-dock-head' },
          h('span', { className: 'dsho-dock-title' }, '优化结果'),
          metaParts.length === 0
            ? null
            : h('span', { className: 'dsho-dock-meta' }, metaParts.join(' · ')),
          /*
           * 历史入口放在标题行最右边：一眼能看见「有几版」，又不用为它多占一行。
           * 一条都没有时不显示 —— 空列表点进去只有一句「还没有历史」，纯添乱。
           */
          history.length === 0
            ? null
            : h('button', {
                type: 'button',
                className: 'dsho-dock-history-btn',
                'data-open': historyOpen ? 'true' : 'false',
                'aria-expanded': historyOpen ? 'true' : 'false',
                title: historyOpen ? '收起历史版本' : '看看之前优化过的几版',
                onClick: () => { setHistoryOpen((open) => !open) },
              }, `历史 ${history.length}`)
        ),
        // 历史列表：展开才渲染，收起时一个节点都不留。
        historyOpen
          ? h('div', { className: 'dsho-dock-history', role: 'list' },
              // 清空入口：20 条封顶但一条条删很烦，给一个一次到底的出口。
              h('div', { className: 'dsho-dock-history-head' },
                h('span', null, `共 ${history.length} 版`),
                h('button', {
                  type: 'button',
                  className: 'dsho-dock-history-act',
                  'data-danger': 'true',
                  title: '清空全部历史版本（不影响当前结果）',
                  onClick: (event) => {
                    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                    // 清完列表就空了，还浮着只剩一个「共 0 版」的空壳。
                    setHistoryOpen(false)
                    if (typeof clearHistory === 'function') clearHistory()
                  },
                }, '清空')),
              history.map((item) => {
                const isViewing = viewing !== null && viewing.id === item.id
                const isCompare = state.compareId === item.id
                return h('div', {
                  key: item.id,
                  className: 'dsho-dock-history-row',
                  role: 'listitem',
                  'data-current': isViewing ? 'true' : 'false',
                  /*
                   * 定高后列表是浮层，盖的正是正文 —— 选完不收起，
                   * 用户会盯着自己的列表发呆，看不见刚翻到的那一版。
                   */
                  onClick: () => { setHistoryOpen(false); viewHistory(item) },
                },
                  h('span', { className: 'dsho-dock-history-time' }, formatHistoryTime(item.at)),
                  item.meta && item.meta.style
                    ? h('span', { className: 'dsho-dock-history-tag' }, item.meta.style)
                    : null,
                  /*
                   * 这一版「为什么和别的版不一样」：被档位收敛过、从过度扩写拉回过、
                   * 或者走的是免费通道。只显示档位的名字不够 —— 用户看不出
                   * 那一版是模型正常输出，还是被兜底改过的。
                   */
                  ...historyBadges(item).map((badge) => h('span', {
                    key: badge.text,
                    className: 'dsho-dock-history-tag',
                    'data-kind': badge.kind,
                    title: badge.title,
                  }, badge.text)),
                  h('span', { className: 'dsho-dock-history-text', title: historySnippet(item) },
                    historySnippet(item)),
                  h('button', {
                    type: 'button',
                    className: 'dsho-dock-history-act',
                    'data-active': isCompare ? 'true' : 'false',
                    title: isCompare ? '取消对比' : '和正在看的这一版并排对比',
                    onClick: (event) => {
                      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                      // 同上：并排两栏也被浮层盖着，收起才能看见对比结果。
                      setHistoryOpen(false)
                      compareHistory(item)
                    },
                  }, isCompare ? '取消对比' : '对比'),
                  h('button', {
                    type: 'button',
                    className: 'dsho-dock-history-act',
                    'data-danger': 'true',
                    title: '删掉这一版',
                    onClick: (event) => {
                      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                      deleteHistory(item.id)
                    },
                  }, '删除')
                )
              })
            )
          : null,
        /*
         * 横幅：正在看历史、或者正在对比时必须有 ——
         * 否则用户会以为这就是刚生成的结果，接着点「替换草稿」把旧版写进输入框。
         */
        viewing
          ? h('div', { className: 'dsho-dock-banner', role: 'status' },
              h('span', { className: 'dsho-dock-banner-text' },
                comparing
                  ? `对比：左边是 ${formatHistoryTime(compareEntry.at)} 那版，右边是 ${formatHistoryTime(viewing.at)} 那版`
                  : `正在看 ${formatHistoryTime(viewing.at)} 那版历史（不是当前结果）`),
              comparing
                ? h('button', {
                    type: 'button',
                    className: 'dsho-dock-banner-act',
                    onClick: () => { compareHistory(compareEntry) },
                  }, '退出对比')
                : null,
              h('button', {
                type: 'button',
                className: 'dsho-dock-banner-act',
                onClick: () => { exitHistoryView() },
              }, '回到当前结果')
            )
          : null,
        usageParts.length === 0
          ? null
          : h('span', { className: 'dsho-dock-usage' }, usageParts.join(' · ')),
        conflict
          ? h('div', { className: 'dsho-dock-warn', role: 'status' },
              '你在等待期间改过输入框，这份结果不会覆盖你新写的内容。'
              + '想用就复制，或重新优化一次。')
          : null,
        /*
         * 模型的思考过程：模型不给就没有这一块。
         *
         * 默认收起 —— 它是旁注，不是结果。展开与否只影响显示，不影响正文。
         */
        state.reasoning !== undefined && state.reasoning !== null && state.reasoning.length > 0
          ? h('div', {
              className: 'dsho-dock-reasoning',
              'data-open': reasoningOpen ? 'true' : 'false',
            },
              h('button', {
                type: 'button',
                className: 'dsho-dock-reasoning-title',
                'aria-expanded': reasoningOpen ? 'true' : 'false',
                title: reasoningOpen ? '收起思考过程' : '展开看模型的思考过程',
                onClick: () => { setReasoningOpen((open) => !open) },
              }, reasoningOpen
                ? '思考过程'
                : '思考过程 · ' + state.reasoning.length + ' 字'),
              reasoningOpen
                ? h('div', { className: 'dsho-dock-reasoning-body' }, state.reasoning)
                : null)
          : null,
        /*
         * 结果正文区：位置固定（普通文档流），高度随卡片走。
         *
         * 对比时换成两栏并排，逐行标出改动；不对比时还是原来那一个正文框 ——
         * 单栏时完全不改结构，避免动到既有测试依赖的节点关系。
         */
        pair !== null
          ? h('div', { className: 'dsho-dock-compare' },
              h('div', { className: 'dsho-dock-col' },
                h('div', { className: 'dsho-dock-col-title' }, pair.leftTitle),
                h('div', {
                  className: 'dsho-dock-col-body',
                  ref: leftBodyRef,
                  onScroll: onColumnScroll,
                },
                  pair.diff.left.map((line, index) => h('div', {
                    key: 'l' + index,
                    className: 'dsho-diff-line',
                    'data-changed': line.changed ? 'true' : 'false',
                    'data-side': 'left',
                    'data-filler': line.filler ? 'true' : 'false',
                  }, line.text === '' ? '\u00a0' : line.text)))),
              h('div', { className: 'dsho-dock-col' },
                h('div', { className: 'dsho-dock-col-title' }, pair.rightTitle),
                h('div', {
                  className: 'dsho-dock-col-body',
                  ref: rightBodyRef,
                  onScroll: onColumnScroll,
                },
                  pair.diff.right.map((line, index) => h('div', {
                    key: 'r' + index,
                    className: 'dsho-diff-line',
                    'data-changed': line.changed ? 'true' : 'false',
                    'data-side': 'right',
                    'data-filler': line.filler ? 'true' : 'false',
                  }, line.text === '' ? '\u00a0' : line.text))))
            )
          : h('div', {
              className: 'dsho-dock-frame',
              ref: frameRef,
            },
              h('div', {
                className: 'dsho-dock-body',
              }, shownText)),
        h('div', { className: 'dsho-dock-actions' },
          // 看历史时「复制」拿的是那一版，「替换草稿」换成了它 —— 按钮跟着眼睛走。
          h('button', {
            type: 'button',
            className: 'dsho-dock-btn',
            onClick: () => { void copyPreview(viewing ? viewing.result : undefined) },
          }, '复制'),
          // 「对比原文」：结果 vs 用户自己写的那句。不需要先看历史，任何时候都能点。
          // 已经在对比原文时由下面 pair 分支出「退出对比」，这里不再出第二个同名按钮。
          canCompareOriginal && pair === null
            ? h('button', {
                type: 'button',
                className: 'dsho-dock-btn',
                'data-active': comparingOriginal ? 'true' : 'false',
                title: comparingOriginal ? '收起并排，回到结果' : '左右并排看我原来写的那句',
                onClick: () => {
                  previewStore.set({ comparingOriginal: !comparingOriginal })
                },
              }, comparingOriginal ? '退出对比' : '对比原文')
            : null,
          // 对比视图下没有「重新优化」的语义（用户正在看两份），先收起再给。
          pair !== null
            ? h('button', {
                type: 'button',
                className: 'dsho-dock-btn',
                onClick: () => {
                  if (comparing) compareHistory(compareEntry)
                  else previewStore.set({ comparingOriginal: false })
                },
              }, '退出对比')
            : h('button', {
                type: 'button',
                className: 'dsho-dock-btn',
                onClick: () => { void reoptimizePreview() },
              }, '重新优化'),
          h('button', {
            type: 'button',
            className: 'dsho-dock-btn',
            onClick: () => { discardPreview() },
          }, '放弃'),
          viewing
            ? h('button', {
                type: 'button',
                className: 'dsho-dock-btn',
                'data-primary': 'true',
                disabled: state.phase === 'running',
                title: '把这一版历史写回输入框',
                onClick: () => { adoptHistory(viewing) },
              }, '用这一版')
            : h('button', {
                type: 'button',
                className: 'dsho-dock-btn',
                'data-primary': 'true',
                disabled: conflict || state.phase !== 'ready',
                title: conflict
                  ? '你在等待期间改过输入框，先复制或重新优化'
                  : state.phase !== 'ready'
                    ? '还在生成中，等生成完再采用'
                    : '用这份结果替换输入框里的内容',
                onClick: () => { adoptPreview() },
              }, '替换草稿')
        )
      )
    }

    // ── 错误边界 ──────────────────────────────────────────────────────────

    /** 渲染异常只影响这个插件的界面，不牵连整个设置页。 */
    function safe(Component) {
      return class Boundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        render() {
          if (this.state.failed) {
            return h('div', { className: 'dsho-status', 'data-kind': 'err' },
              '优化设置加载出错，请刷新页面重试。')
          }
          return h(Component, this.props)
        }
      }
    }

    // ── 设置导航图标 ──────────────────────────────────────────────────────

    /*
     * 宿主的设置导航按 section id 硬编码图标，只认 account / models /
     * agent-presets / plugins / archived-sessions 五个，其余一律返回齿轮
     * （见 dsh-client-ui-settings-general 的 navIcon）。而 settings.section
     * 的注册接口只接受 id / order / label，没有 icon 字段。
     *
     * 所以这里自己动手：给导航行打一个 data 属性，再用 mask-image 把默认
     * 齿轮换成这个插件的图标。用 mask 而不是 background-image，是为了让
     * 颜色跟随 `currentColor` —— 选中时文字变蓝，图标自动跟着变蓝。
     */
    const NAV_ATTR = 'dshnav'
    const NAV_VALUE = 'dsh-prompt-optimizer'
    const NAV_LABEL = '优化'

    /** 双星图标（与输入框的优化按钮同一形状），stroke 用纯黑供 mask 取 alpha。 */
    const NAV_MASK = 'url("data:image/svg+xml,'
      + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' "
        + "stroke='#000' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>"
        + "<path d='M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'/>"
        + "<path d='M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'/>"
        + '</svg>',
      )
      + '")'

    const NAV_CSS = `
button[data-${NAV_ATTR}="${NAV_VALUE}"] > svg{display:none}
button[data-${NAV_ATTR}="${NAV_VALUE}"]::before{
  content:'';flex:none;
  width:16px;height:16px;
  background-color:currentColor;
  -webkit-mask:var(--dsho-nav-mask) center / contain no-repeat;
  mask:var(--dsho-nav-mask) center / contain no-repeat;
}
`

    /**
     * 找到设置导航里属于本插件的那一行并打标记。
     *
     * 定位方式：按钮的直属 span 文本等于「优化」，且它有一个 svg 兄弟
     * （导航行才同时有图标和文字），父容器里还含「通用设置」以排除别处的同名项。
     * 找不到就安静返回，不抛错。
     */
    function decorateNavRow() {
      try {
        const buttons = document.querySelectorAll('button')
        for (const button of buttons) {
          if (button.dataset[NAV_ATTR] === NAV_VALUE) continue
          if (button.querySelector(':scope > svg') === null) continue
          const label = button.querySelector(':scope > span')
          if (label === null || label.textContent.trim() !== NAV_LABEL) continue
          const list = button.parentElement
          if (list === null || !list.textContent.includes('通用设置')) continue
          button.dataset[NAV_ATTR] = NAV_VALUE
          button.style.setProperty('--dsho-nav-mask', NAV_MASK)
        }
      } catch {
        /* 定位失败不影响设置页本身 */
      }
    }

    /** 装上观察器：设置面板每次打开都要重新打标记（DOM 会被重建）。 */
    function installNavIcons() {
      try {
        const style = document.createElement('style')
        style.textContent = NAV_CSS
        document.head.appendChild(style)
        decorateNavRow()

        let queued = false
        const observer = new MutationObserver(() => {
          if (queued) return
          queued = true
          // 合并同一帧内的多次变更，避免设置面板动画期间反复扫描。
          requestAnimationFrame(() => {
            queued = false
            decorateNavRow()
          })
        })
        observer.observe(document.body, { childList: true, subtree: true })

        return () => {
          observer.disconnect()
          style.remove()
        }
      } catch {
        return undefined
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installNavIcons())

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-prompt-optimizer',
          order: 10,
          label: () => '优化',
        }, safe(OptimizeButton)))

        // 预览卡：输入框上方的整条卡位，和按钮分处两个槽位，靠 previewStore 同步。
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-prompt-optimizer-preview',
          order: 15,
          label: () => '优化结果',
        }, safe(PreviewCard)))

        // 会话头按钮：和输入框按钮共用 previewStore，所以状态天然一致。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-prompt-optimizer',
          order: 5,
          label: () => '优化',
        }, safe(HeaderOptimizeButton)))

        // Alt+O：宿主快捷键服务在 Web 端不放行纯 Alt 组合，所以自己挂监听。
        ctx.effect(() => installShortcut(ctx))

        // /optimize 的裸调用：光敲命令名时跑在当前草稿上。
        installCommandEntry(ctx)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-prompt-optimizer',
          order: 45,
          label: () => '优化',
        }, safe(SettingsPage)))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-prompt-optimizer-free',
          order: 60,
          label: () => '免费通道',
        }, safe(FreeChannelPrompt)))
      },
    }
  },
})

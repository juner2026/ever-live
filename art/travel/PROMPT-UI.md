# 旅途 · UI 底图与「放字」规则

> 一句话：**底图只画纸和装饰，字一律留空；文字全部由 HTML 叠上去。**
> 现用文件：`ever/art/travel/ui-popup.jpg`（事件弹窗底图，944×1478）
> 成品页：`ever/travel-ui7.html`

---

## 1. 生 UI 底图的提示词（可直接复用）

```
Vertical mobile app UI background, kawaii sticker-journal style, 9:16 tall. Cream paper page
with soft rounded corners on a pale pink grid background, a folded corner at top right, a
dashed border inset, one strip of pink striped washi tape at the top edge, a small pale
crescent moon sticker with a sleeping face, a tiny paw-print sticker, one little white cat
sticker, a thin dusty-pink dotted travel route with two small station dots and a tiny train,
a small pink toggle switch, one small outlined pill button. Leave big EMPTY blank areas with
no decoration for text: blank header band at top left, blank space right of the moon, a blank
photo frame area (plain light pink, empty) in the middle, a blank note card area below it,
blank line at the bottom. Flat pastel illustration, soft shadows, cream, dusty pink and blush
palette, no letters, no words, no numbers, no text at all, no watermark
```
`size=1024x1536`。这一张出来就是成品弹窗底图，裁掉外围粉格外框 → `944×1478`。

**生图时必须写死的三件事**
1. 卡片是**竖长条**（≈0.64 宽高比），四角圆，右上折角。
2. 里面要有**四个空块**：顶部虚线框、中段粉色相框、下方虚线大框、左下空心胶囊。
3. **一个字母都不许出现**（包括 `EST`、`NO.01` 这种）。

---

## 2. 成品卡片的几何（量出来的，不是估的）

弹窗在 430×932 的手机里：`394 × 617`，水平居中、垂直居中（top 157.5）。

底图 `944×1478` → 卡片百分比：

| 区块 | 底图像素 | 卡片 % | 谁住在这里 |
|---|---|---|---|
| 顶部虚线框 | x 46–580 / y 46–180 | L 4.9 · T 3.1 · R 61.4 · B 12.2 | caps 小字 + 英文标题 |
| 月亮右侧空白 | x 600–930 / y 180–420 | — | 走到第几分钟（`00:42`） |
| 粉色相框 | x 66–876 / y 413–877 | T 27.9 · B 59.3 | 现场那句话；选完换成结论 |
| 路线（虚线+小火） | y 887–959 | T 60 · B 64.9 | 出发/到站两个地名 |
| 下方虚线大框 | x 47–895 / y 1004–1328 | L 5 · T 67.9 · R 94.8 · B 89.9 | 三个方案（29px 高，间隔 8px） |
| 右下开关 | x 781–907 / y 990–1056 | L 82.7 · T 67 | **画好的，不要盖**；说明写在它下面 |
| 左下空胶囊 | x 63–231 / y 1266–1339 | L 6.7 · W 17.6 | 「看另一条路」 |
| 页脚线 | y 1440 | 97.4 | `NO.01 · EVENT` / `01 / 03` |

> 换底图后**必须重新量**：用 PIL 扫虚线颜色（≈`#e6bdb7`）的行/列，拿到边界再换算百分比。
> 别用眼睛对，差 10px 就穿框。

---

## 3. 放字规则

- **字号**：标题 22px（Great Vibes）· 正文 12.5–13px（宋体 m2serif）· caps 标签 5.6–6.5px（Special Elite，字距 1.2–1.8px）· 数字 18–20px（Playfair，tabular-nums）。
- **行高**：正文 1.9；caps 1.5；标题 1.05（越大越紧）。
- **颜色**：文字 = 底图线稿色 `#7a4f4f`；次级 `#8f5f5e`；说明 `#ab7a76`。**不要用纯黑/冷灰**。
- **对齐**：所有块都对齐底图的框内边，左右各留 1% 的气口；不许压虚线。
- **长度**：一句话不超过 2 行；方案标签 ≤ 6 字；caps ≤ 18 字符。
- **不写**：表情符号、`!`、大写感叹；文案只写"外面发生了什么"，不写心情。

---

## 4. 动效（已定）

| 动作 | 工具 | 参数 |
|---|---|---|
| 弹窗出现 | transform+opacity | 300ms `cubic-bezier(.23,1,.32,1)`，scale .96→1 |
| 背景压暗 | opacity | 220ms 同曲线 |
| 选项按下 | transform | `scale(.985)`，120ms |
| 选中 | background+勾 | 160ms |
| 结论顶替相框 | display 切换（不做位移） | 立刻，避免"两层字"叠在一起 |
| 关闭 | 反向：scale→.96 + opacity→0 | 260ms |
| 减少动态 | `prefers-reduced-motion` | 只留 opacity |

---

## 5. 这一屏的可点清单

1. 三个方案 → 结论写回相框，右下打勾
2. 「看另一条路」→ 还原
3. 右上 × / 点背景 → 关闭
4. 关掉后底部 `reopen` → 再开

---

## 6. 贴纸怎么贴（少量）

- 一次最多 3 枚，**只贴在留白处**：卡片外沿、页脚边上、相框空角。
- 尺寸 20–46px，旋转 ±8°，`filter: drop-shadow` 一点点，**不要发光**。
- 现在用了：`sparkle`（标题右上）· `heart`（相框右下角）· `cloud`（背后那页左上）。
- 素材在 `ever/art/travel/stk/`（9 枚，透明 WebP）。

---

# 附加：整页「在途」屏（travel-ui8.html）

底图：`ever/art/travel/ui-page.jpg`（848×1460，比例 0.5808，从 1024×1536 里按纸页边界裁出来）
页面尺寸：430×932 里放 `394×678`，`top:127` 居中。

## 生这张底图的提示词

```
Full-screen mobile page, kawaii sticker-journal style, tall 9:16. A cream paper page fills the
middle 63% of the width, with wide plain pale-pink grid margins on both sides. On the page:
rounded corners, folded corner top right, thin dashed border inset, one pink striped washi tape
at the very top, a small blank dashed label box at the top left, a LARGE EMPTY white-bordered
photo frame in the middle (plain light pink inside, absolutely empty, no picture inside), a small
blank sticky-note shape below it, a dusty-pink dotted route line with two station dots and one
tiny train, a small pink toggle switch at the bottom right, one outlined pill button at the bottom
left, a thin footer line near the bottom. Flat pastel illustration, soft shadows, cream blush
dusty-pink palette, no letters, no words, no numbers, no text at all, no watermark.
```

## 区块 → 放字（百分比相对纸页 394×678）

| 区块 | 位置 % | 放什么 |
|---|---|---|
| 顶部虚线小框 | 框实测 6.49–45.64% / 4.93–10.89%；字放在 L 8 · T 5.6 · W 36 | `TRIP 01 · 夜车`（5.4px caps）+ `en route`（22px Vibes） |
| 小框右侧 | L 52 · T 5 · W 33（右对齐） | `41:05` 18px Playfair + `TO ARRIVAL` 6px |
| 取景框 | 外沿实测 7.08–94.34% / 13.01–63.36%；框 L 7.1 · T 13 · W 87.2 · H 50.35，7px 白相纸边 | **照片位** + 相机取景：四角括角、三分线、中心对焦框、`AF·4:3` `REC`、`CABIN 4 · WINDOW SEAT`、`ISO 400 · 1/60`、`按一下对焦`；**对焦后取景框保留，只收掉提示** |
| 便利贴 | L 10 · T 67.2 · W 33 · rotate -8° | 她的一句话 10.8px/1.8 + `— she, 21:04` Caveat 12px |
| 路线左下站 | L 33 · T 84.6 | `BEIJING 21:00` 6px caps |
| 路线右上站 | R 5.6 · T 64.4（右对齐） | `REYKJAVÍK 06:41` 6px caps |
| 里程 | R 4 · T 81.2 | `还剩 41:05` 9px |
| 左下胶囊 | 实测 7.66–35.97% / 88.3–93.6%；按钮 L 7.9 · T 88.4 · W 27.9 · H 5.2（文字居中） | `敲一下窗`（点一下换一句话） |
| 右下开关 | 画好的，不动 | 说明挂左侧 R 26.5 · T 88.2：`静音 / 这一小时别吵` |
| 页脚 | bottom 2.9% | `NO.01 · 夜车` / `01 / 05` |
| 桌面 | 纸页外下方 | 一张 `ticket.webp` 贴纸（少量）+ 底部导航 |

## 照片接入口

```html
<!-- ① 直接写死一张 -->
<img id="photo" src="ever/art/travel/reykjavik-1.jpg" alt="">
<!-- ② 或者运行时塞（会顺便把右下角 PHOTO·4:3 小标隐掉） -->
<script>setTravelPhoto('art/travel/reykjavik-1.jpg')</script>
```
照片规格：横构图 4:3 或 3:2，短边 ≥900px，≤800KB；框内自动 `cover` 裁切，不用预处理。

## 动效

- 纸页进场：`opacity 0→1 + translateY 8px`，400ms `cubic-bezier(.23,1,.32,1)`
- 照片对焦：`blur(12px) scale(1.04) → 0`，600ms 同曲线；**取景框保持 92% 不消失**，只隐藏「按一下对焦」
- 敲窗：便利贴 `rotateX(65°) + opacity`，190ms 出 / 190ms 回
- 倒计时：1s 一步，到 0 变 `到了`
- 按压：`scale(.97)`，120ms
- `prefers-reduced-motion`：去掉位移动画，只留 opacity

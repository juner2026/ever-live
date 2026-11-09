# 旅途 · 素材生图风格（以后都按这个来）

> 模型：`gpt-image-2`　接口：`POST https://api.jumengai.net/v1/images/generations`
> 尺寸：横板 `1536x1024`，竖板 `1024x1536`
> 产出：贴纸 / 底纹 / UI 底图。**所有图里都不许出现文字**（模型写不好字，字全部由 HTML 叠）。

---

## 1. 这套东西长什么样（必须一致）

- **质感**：水彩 + 纸浆的平涂，边缘软，边缘有一圈**奶白 die-cut 白边**（贴纸感）。
- **纸纹**：极细的纸纤维噪点，像印在米色卡纸上，不要塑料高光、不要玻璃反光。
- **颜色（取色自成品，别自由发挥）**
  - 纸：`#fbefe4` / `#fffdf9`
  - 粉：`#fadada` `#f6d6e1` `#eebccc` `#e09cb5` `#cc7d9b`
  - 线稿：`#aa807b` `#c98c8b` `#d59293`（**不要纯黑**）
  - 点缀：奶油黄 `#f6dfae`、薄荷灰绿 `#b7cdb4`、雾蓝 `#a9c6d4`
- **形状**：圆角、胖、对称、可爱；不要锐角、不要写实透视。
- **表情**：闭眼 + 腮红 + 小弧线嘴；不要牙齿、不要眼睛高光点。
- **禁止**：任何字母/数字/水印、写实照片感、强阴影、渐变高光、赛博/霓虹、3D 渲染感、纯黑描边。

---

## 2. 贴纸板（一次出 9 枚，用来拆）

```
kawaii sticker sheet for a travel journal, nine small die-cut stickers with white borders
arranged loosely on a pale cream card: a sleeping white cat with a pink scarf, a paw print,
a crescent moon with a sleeping face, a tiny pink train, a camera, a train ticket, a heart,
a four-point sparkle, a small cloud; flat pastel illustration, dusty rose cream and mint
palette, soft drop shadows, top-down view, no text, no watermark, subtle paper grain
```
尺寸 `1536x1024`。出完自己裁 3×3 九格 → 逐张抠底（白边外侧那圈奶白纸要去掉）。

## 3. 单枚贴纸（要更大更干净时）

```
single die-cut sticker of {物体}, thick cream-white sticker border, flat pastel watercolor
illustration, soft paper grain, isolated on plain white background, centered, no shadow,
no text, no watermark
```
尺寸 `1024x1024`。**背景一定要纯白**，抠图只按白底一刀切。

## 4. 纸纹 / 底纹（几乎不用生图，但需要时）

```
seamless ivory paper texture, very subtle cotton fibers, faint warm speckles, flat even
lighting, no objects, no text, macro photograph of art paper
```
→ 用 `mix-blend-mode:multiply` 叠，透明度 0.4~0.6。

## 5. 出图后处理（固定流程）

1. `PIL` 打开 → 转 RGB
2. 需要卡片的：按目标比例裁（弹窗裁成 `944×1478`，比例 `0.6387`）
3. 存 JPG：`quality=88~90, optimize=True, progressive=True`
4. 单张 ≤ 200KB 最好（≤800KB 是硬上限）
5. 贴纸：WebP/PNG 带透明，透明底必须**自己抠**（模型不会给干净 alpha）

## 6. 命名

- 贴纸：`ever/art/travel/stk/{cat,paw,moon,train,camera,ticket,heart,sparkle,cloud}.webp`
- 整板：`ever/art/travel/sticker-sheet-full.png`
- UI 底图：`ever/art/travel/ui-popup.jpg`（弹窗）、`ui-page.jpg`（整页）
- 风景：用户自己找，放 `ever/art/travel/{slug}-{n}.jpg`

## 7. 一句话检查表

- [ ] 图里一个字母都没有？
- [ ] 线稿是暖玫瑰棕，不是黑？
- [ ] 有奶白贴纸边 / 纸纹？
- [ ] 颜色全部落在上面的色板里？
- [ ] 尺寸/体积达标？

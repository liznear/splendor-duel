# PROTOTYPE 素材目录（三个 variant 共用棋盘和 token）

`token-*.png` 为原创程序生成图片，不使用截图、裁剪或色相替换。
彩色圆心有细微斑驳纹理，边框为接近白色的淡象牙色做旧纹理。全套 256×256 透明 PNG。
`socket.png` 是同款空心淡色环。预览：`/assets/token-preview.png`。
重建：`python3 scripts/prototype_tokens.py`（纯标准库，无第三方依赖；网页运行无需 Python）。

| 文件 | 用途 |
| --- | --- |
| `board.png` | 旧 BGA 底图，已不再用于棋盘 |
| `token-{white,blue,green,red,black,pearl,gold}.png` | 宝石 token (256×256 透明, 原创生成) |
| `socket.png` | 空槽座 (纯边框环, 棋盘空格用) |
| `privilege.png` | 特权卷轴图标 (19×57 透明, BGA) |
| `background.png` | 官方桌面背景 (714×400, BGA) |

棋盘由 CSS 原创绘制，最大 360px：底色跟随 variant，5×5 方格、圆槽与 token 共用尺寸。
`refill-spiral.svg` 标注补充顺序 1–25，从中心向左，向外螺旋，补充时跳过已占用格。
路线直接从后端 `game.Spiral` 生成：`python scripts/prototype_refill.py`。
版权: Space Cowboys, 仅个人本地使用, 勿公开分发。

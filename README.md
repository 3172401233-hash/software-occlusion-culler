# software-occlusion-culler

纯 Node.js 实现的 CPU 软件遮挡剔除库，用于游戏引擎在提交 draw list 之前
剔除大型场景中不可见的物体。**零第三方依赖、零 GPU 调用、无画面显示、
无编辑器**，只输出 `visible` / `occluded` / `uncertain` 三态分类与统计信息。

## 特性

- 纯 ESM，仅使用 Node.js 内置模块（`node:test` 用于测试）。
- 完整遮挡体渲染流水线：世界→视图→裁剪空间变换、近裁剪面处理、
  透视除法、屏幕空间深度光栅化。
- 近裁剪面采用裁剪空间 `z_clip >= 0` 半空间 Sutherland–Hodgman 裁剪，
  零 `w`、相机后方、非有限数值顶点在透视除法之前就被丢弃。
- 光栅化像素索引全部钳制在视口内，超大三角形、视口外三角形、退化
  （零面积）三角形都不会产生越界写入。
- 深度以 `Uint32` 定点数存储，相同输入在任何机器上产生逐位一致的
  深度图、HiZ 金字塔和分类结果。
- 层级 Z（HiZ）金字塔按 2×2 取最大深度构建，空洞保持 `INVALID`，
  查询触碰到任何未覆盖区域时拒绝给出遮挡结论。
- 保守判定：只有包围盒的整个可能覆盖区域都有遮挡体、且包围盒最近
  可能表面严格深于所有覆盖深度时才标记 `occluded`。

## 安装与测试

```bash
npm test
# 等价于
node --test
```

要求 Node.js >= 18（使用内置 test runner 与 ESM）。

## 快速上手

```js
import { OcclusionCuller } from "software-occlusion-culler";

const camera = {
  eye: [0, 0, 0],
  target: [0, 0, -1],
  up: [0, 1, 0],
  fovY: Math.PI / 3,
  near: 1,
  far: 100,
  // 可选：aspect 默认取 depthWidth / depthHeight
};

const culler = new OcclusionCuller({ depthWidth: 64, depthHeight: 48 });

// 遮挡三角形：每个三角形是 3 个世界空间顶点 [x, y, z]
const occluders = [
  [
    [-8, -8, -10],
    [8, -8, -10],
    [8, 8, -10],
  ],
];
culler.renderOccluders(camera, occluders);

// 候选物体：世界空间轴对齐包围盒 { min, max }
const result = culler.classifyBox(camera, {
  min: [-1, -1, -13],
  max: [1, 1, -12],
});
// result.status === "occluded"

console.log(culler.stats);
```

## 三态语义

| 状态 | 含义 | 引擎建议 |
| --- | --- | --- |
| `visible` | 有证据表明物体可能可见：比遮挡体近、深度持平、或与近裁剪面相交 | 提交绘制 |
| `occluded` | 整个投影覆盖区域均被遮挡体覆盖，且物体最近表面严格位于遮挡体之后 | 可安全剔除 |
| `uncertain` | 信息不足：视锥外、投影覆盖到空深度/视口外、或包围盒覆盖范围无法完全确认 | 提交绘制（保守） |

`occluded` 是唯一允许剔除的状态；库保证不会把实际可见物体误判为
`occluded`（在下文“保守性边界”列出的数值与采样范围内）。

## 处理流水线

1. **矩阵构建**：`lookAt` 视图矩阵与 `perspective` 透视矩阵
   （NDC 深度为 D3D 风格 `[0,1]`），列主序 `Float64Array` 存储。
2. **视锥测试**：从视图投影矩阵提取六个平面，对包围盒 8 个角点做
   p-vertex 测试；任一角点在平面正侧即判定相交，完全在负侧才拒绝。
3. **近裁剪面处理**：在裁剪空间对 `z_clip = 0` 做 Sutherland–Hodgman
   单平面裁剪，保留 `z_clip >= 0 && w > 0` 的顶点与交点；输出扇形
   重新三角化。
4. **透视除法与视口映射**：`ndc = clip.xyz / clip.w`，再映射到深度图像素。
5. **深度光栅化**：有向边函数 + top-left 填充规则，重心坐标在屏幕空间
   插值 NDC z，量化为 `Uint32`；nearest-depth 通过则写入并计数。
6. **HiZ 构建**：level 0 为原始深度，每层 2×2 取最大深度，缺失子像素与
   空洞保持 `0xffffffff`（`INVALID_DEPTH`）。
7. **包围盒分类**：投影 8 角点得到外扩 1 像素的保守屏幕矩形，选取合适
   mip 层级查询；含 `INVALID` 即 `uncertain`，否则比较最大遮挡深度与
   包围盒最近深度（严格小于才遮挡）。

## API

### `new OcclusionCuller({ depthWidth, depthHeight })`

创建指定低分辨率深度图尺寸的剔除器，尺寸必须为正整数，支持非 2 的幂。

### `renderOccluders(camera, triangles)`

光栅化全部遮挡三角形并重建 HiZ，返回 `snapshot()`。三角形为
`[[x,y,z], [x,y,z], [x,y,z]]` 形式；可重复调用，深度写入会累积。

### `classifyBox(camera, box)` / `classifyBoxes(camera, boxes)`

返回 `{ status, frustum, reason, hizLevel? }` 或其数组。
`frustum` 为 `"inside"` / `"intersects"` / `"outside"`。

### `snapshot()`

返回深度图、每一级 HiZ（`Uint32Array` 拷贝）与统计快照，可用于持久化
或逐位一致性校验。

### `reset()`

清空深度图、HiZ 与全部统计计数。

### `stats`

- `candidatesTested`：参与分类的候选包围盒数量。
- `occluderTrianglesSubmitted` / `occluderTrianglesRasterized`：提交与
  裁剪后实际光栅化的遮挡三角形数量。
- `depthWrites`：深度缓冲写入次数（含覆盖更新）。
- `occupiedPixels`：深度图中被占用（非 `INVALID`）的像素数。
- `occluded` / `visible` / `uncertain`：三态分类计数。
- `frustumRejected`：视锥外被拒绝的候选数量（计入 `uncertain`）。

## 保守性边界

库在设计上宁可保留也不误剔除，但下列边界属于有意的保守行为，调用方
需要知晓：

1. **像素中心采样**：光栅化在像素中心判定覆盖。比一个像素还细的遮挡
   体或缝隙可能采样不到，此时深度保持空洞，查询得到 `uncertain` 而不是
   `错误的 occluded`。提高深度图分辨率可缓解。
2. **1 像素外扩**：候选包围盒的屏幕矩形向外膨胀 1 像素，贴边物体因此
   可能落到 `uncertain`，但永远不会因取整误差被误剔除。
3. **严格深度比较**：包围盒最近深度与遮挡深度持平时判定 `visible`，
   避免共面闪烁导致的错误剔除。
4. **HiZ 取最大深度**：每个 mip 纹素保存覆盖范围内最远的最近表面，
   并保留 `INVALID`；矩形只要触及空洞或非 2 次幂边缘的填充纹素就返回
   `uncertain`。
5. **近裁剪面相交即可见**：任一角点 `w <= 0`（位于近平面或相机后方）
   且包围盒未整体落在视锥外时，直接判定 `visible`。
6. **视锥外为 `uncertain`**：完全在视锥外的物体返回
   `status: "uncertain", frustum: "outside"` 并给出 `frustum:<plane>`
   原因，引擎可据此单独执行视锥剔除；这样三态分类本身不会把任何物体
   标记为可遮挡剔除。
7. **浮点中间量、定点存储**：变换与边函数使用 IEEE-754 float64，持久
   深度为 uint32；同一 Node.js 版本与输入下输出逐位一致，跨架构的
   float64 基本运算同样遵循 IEEE-754。
8. **量化误差**：遮挡体深度四舍五入、包围盒最近深度向下取整，共面或
   距离小于一个 uint32 深度刻度（NDC 上约 `2.3e-10`）的极限贴合场景
   可能落入 `occluded`；常规场景下该误差对应亚毫米级世界距离。
9. **轴对齐包围盒**：候选体必须是世界空间 AABB；更紧的包围形状需先
   转换为 AABB，保守性由外扩 AABB 自然继承。

## 项目结构

```text
lib/
  mat4.js         列主序矩阵、透视/lookAt/变换
  frustum.js      视锥平面提取与 AABB p-vertex 测试
  clip.js         裁剪空间近平面 Sutherland-Hodgman 裁剪
  depth.js        uint32 定点深度编码与 INVALID 哨兵
  rasterizer.js   边函数光栅化、top-left 规则、nearest-depth
  hiz.js          HiZ 金字塔构建与保守矩形查询
  culler.js       OcclusionCuller 主类与三态分类
  index.js        统一导出
test/
  helpers.js      确定性 PRNG 与几何生成器
  unit.test.js    矩阵、裁剪、光栅化、HiZ 单元测试
  scenarios.test.js 端到端场景测试
```

## 测试覆盖

`node --test` 覆盖：前后遮挡、边缘空洞、薄缝、近裁剪面穿插、完全在相机
后方、零 `w` 与退化三角形、空遮挡体、HiZ 层级查询、非 2 次幂高分辨率
边界、深度持平、多遮挡体组合、统计计数、`reset`、近侧物体扫描，以及
两次独立运行的逐位一致性。

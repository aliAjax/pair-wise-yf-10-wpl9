# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间和试奏问题。

## 启动

```bash
PORT=3019 node server.js
```

## 主要接口

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `GET /tunes/:id/fault-bands`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 故障带分析

登记或更新问题后自动分析：按拍号和音轨把相邻区间连起来看，同一音轨在连续两段以上相邻区间都出现未解决问题时，归成一条故障带（音轨需落在区间的音轨范围内）。

- 带里还有未解决问题时，相关区间 `reviewStatus` 转为 `pending_review`（待复核），进度里单列 `pendingReviewSections`，不计入已完成。
- 问题重试通过（状态改为 `resolved`）后故障带才撤下，区间恢复 `normal`；原问题仍保留在 `issues` 记录里。
- 没有问题的曲目按普通处理，进度口径与原来一致。
- 分析结果（`faultBands`）与复核状态（`reviewStatus`）都写入 `data/db.json`。
- 分层维护：`analysis.js` 管计算，`store.js` 管存储，`server.js` 管接口。

## 闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
curl http://127.0.0.1:3019/tunes/tune_demo/fault-bands
```

## 测试

```bash
node test.js
```

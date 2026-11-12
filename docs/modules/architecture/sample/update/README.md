# 更新样例

同一个模块 `health-lite` 的四个版本，用来演示「数据结构只能加」。`check.mjs` 的第五项检查跑前两条命令，`sketch/validate.test.ts` 跑第三条。也可以手工运行：

```
node sketch/validate.ts sample/update/0.2.0-adds-field/health-lite --previous sample/update/0.1.0/health-lite
node sketch/validate.ts sample/update/0.2.0-renames-field/health-lite --previous sample/update/0.1.0/health-lite
node sketch/validate.ts sample/update/0.2.0-changes-unit/health-lite --previous sample/update/0.1.0/health-lite
```

第一条通过，因为 0.2.0 只多了一个字段 `method`。

第二条被拒绝，因为它把 `lab` 改名成了 `laboratory`。在校验器看来，改名就是删掉了 `lab`。

第三条被拒绝，因为它把 `value` 的单位从 `mmol/L` 改成了 `mg/dL`。字段名和类型都没变，可已经存下的数字会被当成另一个单位来读。

# 更新样例

同一个模块 `health-lite` 的五个版本，演示改数据结构时会发生什么。存下来的数据只增不减，模块包决定显示哪些。

```
node sketch/validate.ts sample/update/0.2.0-adds-field/health-lite --previous sample/update/0.1.0/health-lite
node sketch/validate.ts sample/update/0.2.0-renames-field/health-lite --previous sample/update/0.1.0/health-lite
node sketch/validate.ts sample/update/0.2.0-removes-field/health-lite --previous sample/update/0.1.0/health-lite
node sketch/validate.ts sample/update/0.2.0-changes-unit/health-lite --previous sample/update/0.1.0/health-lite
```

第一条通过。0.2.0 多了一个字段 `method`，宿主自动加上，旧的行里它是空的。

第二条通过，并提示一行。`laboratory` 写了 `"was": "lab"`，宿主把 `lab` 存下的值搬到 `laboratory` 名下。

第三条通过，并提示一行。`lab` 从包里拿掉了，它存下的值留着，只是不再显示。提示里说明如果其实是改名该怎么写。

第四条被拒绝。它把 `value` 的单位从 `mmol/L` 改成了 `mg/dL`，已经存下的数字会被当成另一个单位来读。要换单位，就加一个新字段。

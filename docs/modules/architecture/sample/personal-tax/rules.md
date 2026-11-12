# 个人报税模块的规则

## new-transactions
来源: personal-tax/brokerage-statements
券商有新的交易记录时，不用马上开任务。只有当月已实现盈亏的合计超过使用者设过的数额时，才开一个任务，按技能 year-end-estimate 重算一次。

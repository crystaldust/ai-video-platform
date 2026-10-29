# 测试用 skill 副本

只给测试用：平台运行时用 `pack register --root` 注册的真实目录，不读这里。

- 来源：`crystaldust/shuohao-skills` 的 `main`，提交 `9dd7129`（合并 `feat/stable-ids`，内容同 `d1b0ad4`），skill 版本 3.0.0
- 拷贝内容：`novel-outline`、`novel-script` 的 `SKILL.md`、`references/*.md`、`scripts/*.mjs`（不含 `selftest.mjs`）
- `prompt-only/`：平台自己写的假 skill，只有 `SKILL.md`，用来测「只有提示词」的通用配方

上游更新后重新拷贝（在平台仓库根目录执行，`U` 指向上游仓库）：

```bash
for s in novel-outline novel-script; do
  rm -rf test/fixtures/skills/$s && mkdir -p test/fixtures/skills/$s/references test/fixtures/skills/$s/scripts
  cp $U/skills/$s/SKILL.md test/fixtures/skills/$s/
  cp $U/skills/$s/references/*.md test/fixtures/skills/$s/references/
  cp $U/skills/$s/scripts/*.mjs test/fixtures/skills/$s/scripts/ && rm -f test/fixtures/skills/$s/scripts/selftest.mjs
done
```

然后更新本文件里的提交号，并跑 `pnpm test`。

另有两个平台自己写的测试用假 skill：
- `gated-storyboard/`：`ids` 给文档盖章、`validate` 查章与 `bad` 字段，用来测平台门修复后会重新补 id、复查 skill 质量门
- `hangs/`：无参数运行时挂住，用来测能力探测超时只算这一个 skill 的问题

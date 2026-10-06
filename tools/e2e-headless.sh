#!/bin/sh
# 端到端验收：让真正的 DSH 在一个开了开关的项目里跑一次会话。
#
# 全程使用**隔离的 DSH_HOME**（`$WORK/home`），不碰 `~/.dsh`。
# 没有 API key 也能验收持久化：会话在调用模型之前就已经落盘，
# 用占位 key 跑会停在 AUTH 那一步（退出码 1），这正是预期结果。
#
#   tools/e2e-headless.sh            # 全新跑一遍（先清掉上次的临时目录）
#   tools/e2e-headless.sh --keep     # 保留上次的临时目录
#
# 环境变量可覆盖：DSH_APP、WORK、TASK。

set -eu

DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
WORK="${WORK:-/tmp/dsh-in-project-e2e}"
TASK="${TASK:-say pong}"
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

CLI="$DSH_APP/Contents/Resources/runtime/cli/bin/dsh"
NODE_EXEC="$DSH_APP/Contents/MacOS/DeepSeek Harness"
[ -x "$CLI" ] || { echo "找不到 DSH CLI：$CLI" >&2; exit 1; }

case "${1:-}" in
  --keep) ;;
  *) rm -rf "$WORK" ;;
esac

HOME_DIR="$WORK/home"
ENABLED="$WORK/enabled-project"
PLAIN="$WORK/plain-project"
mkdir -p "$ENABLED/.dsh" "$PLAIN"
printf 'sessions: project\n' > "$ENABLED/.dsh/project.yml"

# 启动 shell 里往往已经继承了**正在运行的**那套 DSH_* 变量，必须显式摘掉，
# 否则会写进用户的真实 profile。
dsh() {
  env -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_PROFILE_DIR \
    DSH_HOME="$HOME_DIR" \
    DSH_DESKTOP_NODE_EXECUTABLE="$NODE_EXEC" \
    "$CLI" "$@"
}

# macOS 没有 coreutils 的 timeout；用 perl 的 alarm 兜底，避免挂死。
with_alarm() {
  seconds=$1; shift
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

echo "== 1/5 起一个隔离的 headless profile"
dsh headless --help >/dev/null 2>&1 || true
[ -f "$HOME_DIR/profiles/headless/cordis.yml" ] || { echo "profile 没建起来" >&2; exit 1; }

echo "== 2/5 把本插件登记成 profile link（声明过的 peer 才会解析到 harness 自己的那份）"
dsh plugin --profile headless add "$REPO" >/dev/null 2>&1

echo "== 3/5 写装配补丁：禁用官方后端 + 插入本插件（必须同一层）"
cat > "$HOME_DIR/profiles/headless/cordis.patch.yml" <<'YAML'
- id: session-persistence-jsonl
  name: "@deepseek-ai/dsh-session-persistence-jsonl"
  disabled: true

- insert:
    - id: session-persistence-in-project
      name: dsh-session-persistence-in-project
      config:
        defaultRoot: !!js dshHomePath('sessions')
YAML

echo "== 4/5 核对组装结果"
dsh headless --dump-config > "$WORK/dump.yml" 2>/dev/null
grep -q 'disabled: true' "$WORK/dump.yml" || { echo "官方后端没被禁用" >&2; exit 1; }
grep -q 'session-persistence-in-project' "$WORK/dump.yml" || { echo "本插件没被插入" >&2; exit 1; }

echo "== 5/5 跑两次真实会话（占位 key，预期停在 AUTH）"
for project in "$ENABLED" "$PLAIN"; do
  echo "-- $project"
  ( cd "$project" && with_alarm 240 \
      env -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_PROFILE_DIR \
      DSH_HOME="$HOME_DIR" DSH_DESKTOP_NODE_EXECUTABLE="$NODE_EXEC" \
      DEEPSEEK_API_KEY=dummy "$CLI" headless "$TASK" ) >/dev/null 2>"$WORK/$(basename "$project").err" || true
done

status=0
if find "$ENABLED/.dsh/sessions" -name 'session.v*.jsonl.zstd' 2>/dev/null | grep -q .; then
  echo "OK  开了开关的项目：会话落在项目里"
  find "$ENABLED/.dsh/sessions" -name 'session.v*.jsonl.zstd'
else
  echo "FAIL 开了开关的项目里没有会话产物" >&2; status=1
fi

if find "$PLAIN" -name 'session.v*.jsonl.zstd' 2>/dev/null | grep -q .; then
  echo "FAIL 没开开关的项目里居然出现了会话产物" >&2; status=1
else
  echo "OK  没开开关的项目：什么都没写进项目"
fi

if find "$HOME_DIR/sessions" -name 'session.v*.jsonl.zstd' 2>/dev/null | grep -q .; then
  echo "OK  没开开关的项目：会话落在默认根"
  find "$HOME_DIR/sessions" -name 'session.v*.jsonl.zstd'
else
  echo "FAIL 默认根里没有会话产物" >&2; status=1
fi

echo
echo "落点登记表（$HOME_DIR/session-persistence-in-project/roots.json）："
cat "$HOME_DIR/session-persistence-in-project/roots.json" 2>/dev/null || echo "  （没有——说明项目落点没被登记）"

echo
if [ "$status" -eq 0 ]; then
  echo "端到端验收通过。临时目录：$WORK"
else
  echo "端到端验收失败，日志在：$WORK" >&2
fi
exit "$status"

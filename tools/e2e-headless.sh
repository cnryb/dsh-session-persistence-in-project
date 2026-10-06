#!/bin/sh
# 端到端验收：让真正的 DSH 在一个开了开关的项目里跑一次会话。
#
# 全程使用**隔离的 DSH_HOME**（`$WORK/home`），不碰 `~/.dsh`。
# 没有 API key 也能验收持久化：会话在调用模型之前就已经落盘，
# 用占位 key 跑会停在 AUTH 那一步（退出码 1），这正是预期结果。
#
# 验收内容：
#   1. 开了开关的项目 → 会话落在项目里；没开开关的 → 落在默认根；
#   2. 项目内落点是**扁平**的：`<项目>/.dsh/sessions/<id>/…`，没有 `--<cwd>--` 层；
#   3. 把会话挪成升级前的分层形状后，`--session-id` 续写仍然找得到、写得回原目录，
#      也不会在旁边另造一份扁平副本。
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

# 在某个项目里跑一次真实会话（占位 key，预期停在 AUTH）。
run_in() {
  project=$1; shift
  ( cd "$project" && with_alarm 240 \
      env -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_PROFILE_DIR \
      DSH_HOME="$HOME_DIR" DSH_DESKTOP_NODE_EXECUTABLE="$NODE_EXEC" \
      DEEPSEEK_API_KEY=dummy "$CLI" "$@" )
}

# macOS 没有 coreutils 的 timeout；用 perl 的 alarm 兜底，避免挂死。
with_alarm() {
  seconds=$1; shift
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

# 文件大小（BSD stat）。
size_of() {
  stat -f%z "$1"
}

echo "== 1/6 起一个隔离的 headless profile"
dsh headless --help >/dev/null 2>&1 || true
[ -f "$HOME_DIR/profiles/headless/cordis.yml" ] || { echo "profile 没建起来" >&2; exit 1; }

echo "== 2/6 把本插件登记成 profile link（声明过的 peer 才会解析到 harness 自己的那份）"
dsh plugin --profile headless add "$REPO" >/dev/null 2>&1

echo "== 3/6 写装配补丁：禁用官方后端 + 插入本插件（必须同一层）"
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

echo "== 4/6 核对组装结果"
dsh headless --dump-config > "$WORK/dump.yml" 2>/dev/null
grep -q 'disabled: true' "$WORK/dump.yml" || { echo "官方后端没被禁用" >&2; exit 1; }
grep -q 'session-persistence-in-project' "$WORK/dump.yml" || { echo "本插件没被插入" >&2; exit 1; }

echo "== 5/6 跑两次真实会话（占位 key，预期停在 AUTH）"
for project in "$ENABLED" "$PLAIN"; do
  echo "-- $project"
  run_in "$project" headless "$TASK" >/dev/null 2>"$WORK/$(basename "$project").err" || true
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

echo "== 6/6 布局验收：扁平落点 + 旧分层数据仍可续写"
SESSIONS="$ENABLED/.dsh/sessions"
FLAT=$(find "$SESSIONS" -maxdepth 2 -name 'session.v*.jsonl.zstd' 2>/dev/null | head -1 || true)
if [ -z "$FLAT" ]; then
  echo "FAIL 项目落点里没有产物，没法验布局" >&2; status=1
else
  ID=$(basename "$(dirname "$FLAT")")
  if [ "$(dirname "$FLAT")" = "$SESSIONS/$ID" ]; then
    echo "OK  扁平布局：$FLAT"
  else
    echo "FAIL 产物不在扁平位置：$FLAT" >&2; status=1
  fi
  if find "$SESSIONS" -maxdepth 1 -type d -name '--*--' 2>/dev/null | grep -q .; then
    echo "FAIL 出现了官方那层 --<cwd>-- 目录" >&2; status=1
  else
    echo "OK  没有 --<cwd>-- 项目层"
  fi

  # 模拟「升级前就写在项目里」的存量数据：把它挪进旧形状的目录
  LEGACY_DIR="$SESSIONS/--legacy--/$ID"
  mkdir -p "$SESSIONS/--legacy--"
  mv "$SESSIONS/$ID" "$LEGACY_DIR"
  LEGACY_LOG=$(find "$LEGACY_DIR" -name 'session.v*.jsonl.zstd' | head -1)
  BEFORE=$(size_of "$LEGACY_LOG")

  echo "-- 冷启动续写旧分层会话：$ID"
  run_in "$ENABLED" headless --session-id "$ID" "$TASK" >/dev/null 2>"$WORK/resume.err" || true
  AFTER=$(size_of "$LEGACY_LOG")

  if [ "$AFTER" -gt "$BEFORE" ]; then
    echo "OK  旧分层会话被找到并续写（$BEFORE → $AFTER 字节）"
  else
    echo "FAIL 旧分层会话没有被续写（仍是 $AFTER 字节），见 $WORK/resume.err" >&2
    status=1
  fi
  if [ -e "$SESSIONS/$ID" ]; then
    echo "FAIL 在扁平位置另造了一份副本：$SESSIONS/$ID" >&2; status=1
  else
    echo "OK  没有另造扁平副本"
  fi
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

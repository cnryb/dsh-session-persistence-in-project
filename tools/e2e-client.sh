#!/bin/sh
# 端到端验收（浏览器半侧）：让真正的 DSH 起一个**隔离的 web profile**，确认
# 本插件的客户端 bundle 被组合进启动图、并且真的能从 /plugins 取到。
#
# 这一步验的是只有真跑起来才会暴露的东西：`package.json` 里的 `dsh.client` 声明
# 与 `exports["./client"]` 是否对得上、bundle 是否在启动前就存在。声明了却没有产物
# 时，`dsh-client-modules` 在**启动扫描**阶段就会抛错 —— 那是整个 GUI 的模块系统，
# 不是一个插件的失败。
#
# 全程隔离：自己的 DSH_HOME、自己的 profile、`--port 0`（让 OS 挑端口），
# 跑完就关。不碰用户正在用的那份 profile。
#
#   tools/e2e-client.sh            # 跑一遍
#   tools/e2e-client.sh --keep     # 保留临时目录（含日志）
#
# 环境变量可覆盖：DSH_APP、WORK。

set -eu

DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
WORK="${WORK:-/tmp/dsh-in-project-client-e2e}"
PROFILE="${PROFILE:-plugin-client-probe}"
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

CLI="$DSH_APP/Contents/Resources/runtime/cli/bin/dsh"
NODE_EXEC="$DSH_APP/Contents/MacOS/DeepSeek Harness"
[ -x "$CLI" ] || { echo "找不到 DSH CLI：$CLI" >&2; exit 1; }

case "${1:-}" in
  --keep) ;;
  *) rm -rf "$WORK" ;;
esac
mkdir -p "$WORK"

HOME_DIR="$WORK/home"
PORT_FILE="$WORK/port"
SERVER_PID=""

# 启动 shell 里继承的 DSH_* 变量必须显式摘掉，否则会写进用户真实 profile。
dsh() {
  env -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_PROFILE_DIR \
    DSH_HOME="$HOME_DIR" \
    DSH_DESKTOP_NODE_EXECUTABLE="$NODE_EXEC" \
    "$CLI" "$@"
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

PKG=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1] + "/package.json", "utf8")).name)' "$REPO")

echo "== 1/5 从 web 模板建一个隔离 profile（$PROFILE）"
dsh --profile "$PROFILE" --from-default-profile web --dump-config > "$WORK/dump-template.yml" 2>"$WORK/template.err" \
  || { echo "模板 profile 没建起来" >&2; cat "$WORK/template.err" >&2; exit 1; }
[ -f "$HOME_DIR/profiles/$PROFILE/cordis.yml" ] || { echo "profile 没建起来" >&2; exit 1; }

echo "== 2/5 登记本插件 + 写装配补丁"
dsh plugin --profile "$PROFILE" add "$REPO" >/dev/null 2>&1
cat > "$HOME_DIR/profiles/$PROFILE/cordis.patch.yml" <<'YAML'
- id: session-persistence-jsonl
  name: "@deepseek-ai/dsh-session-persistence-jsonl"
  disabled: true

- insert:
    - id: session-persistence-in-project
      name: dsh-session-persistence-in-project
      config:
        defaultRoot: !!js dshHomePath('sessions')
YAML

echo "== 3/5 起 web（--port 0 由系统挑端口，不碰用户那份）"
dsh --profile "$PROFILE" --no-open --port 0 > "$WORK/web.log" 2>&1 &
SERVER_PID=$!

# 等它打印带 token 的 URL（最多 120 秒）
URL=""
i=0
while [ "$i" -lt 120 ]; do
  URL=$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$WORK/web.log" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  i=$((i + 1))
  sleep 1
done
if [ -z "$URL" ]; then
  echo "FAIL 没等到 dsh web 的 URL，日志：$WORK/web.log" >&2
  tail -20 "$WORK/web.log" >&2 || true
  exit 1
fi
echo "OK  服务起来了：$URL"

echo "== 4/5 取启动图：客户端 bundle 必须已经组合进去"
curl -s -L -c "$WORK/cookies.txt" "$URL" -o "$WORK/index.html"
grep -q "$PKG/client.js" "$WORK/index.html" || {
  echo "FAIL 启动图里没有 $PKG/client.js —— 客户端半侧没被组合" >&2
  exit 1
}
echo "OK  启动图包含 $PKG/client.js"

echo "== 5/5 从 /plugins 取 bundle 本体"
COMBO=$(grep -o "plugins/??$PKG/client\.js&rev=[a-f0-9]*" "$WORK/index.html" | head -1 || true)
[ -n "$COMBO" ] || COMBO=$(grep -o "plugins/??[^\"']*$PKG/client\.js[^\"']*" "$WORK/index.html" | head -1 || true)
[ -n "$COMBO" ] || { echo "FAIL 启动图里找不到 $PKG 的资源 URL" >&2; exit 1; }

BASE=$(printf '%s' "$URL" | sed 's#/?token=.*##')
curl -s -b "$WORK/cookies.txt" "$BASE/$COMBO" -o "$WORK/served.js" -w "http=%{http_code}\n" > "$WORK/served.status"
STATUS=$(sed 's/http=//' "$WORK/served.status")
if [ "$STATUS" != "200" ]; then
  echo "FAIL /plugins 返回 $STATUS（$BASE/$COMBO）" >&2
  exit 1
fi
grep -q 'window.__ModuleLoader__.load' "$WORK/served.js" || { echo "FAIL 取到的不是模块 bundle" >&2; exit 1; }
grep -q 'plugins\.item' "$WORK/served.js" || { echo "FAIL bundle 里没有 plugins.item 槽注册" >&2; exit 1; }
grep -q "$PKG" "$WORK/served.js" || { echo "FAIL bundle 的 id 不是包名" >&2; exit 1; }
echo "OK  /plugins 取到 bundle（$(wc -c < "$WORK/served.js" | tr -d ' ') 字节），槽注册与 id 都对"

echo
echo "客户端半侧端到端验收通过。临时目录：$WORK"

#!/usr/bin/env bash
set -Eeuo pipefail
export GIT_TERMINAL_PROMPT=0

APP_DIR=${JINGCE_APP_DIR:-/opt/jingce-ai-workbench}
STATE_DIR=${JINGCE_DEPLOY_STATE:-/var/lib/jingce-deploy}
REPOSITORY=https://github.com/NGZY-yxm/jingce-ai-workbench.git
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || exit 0
cd "$APP_DIR"

old=$(git rev-parse HEAD)
target=''
stage=''
applied=0

status() {
    node -e 'const fs=require("fs"); const [file,state,commit,previous]=process.argv.slice(1); const tmp=file+".tmp"; fs.writeFileSync(tmp,JSON.stringify({state,commit,previous,checkedAt:new Date().toISOString()})+"\n",{mode:0o600}); fs.renameSync(tmp,file);' \
        "$STATE_DIR/status.json" "$1" "${target:-$old}" "$old"
}

cleanup() {
    if [[ -n "$stage" && "$stage" == "$STATE_DIR"/stage.* ]]; then
        rm -rf -- "$stage"
    fi
}
trap cleanup EXIT

failed() {
    local code=$?
    trap - ERR
    echo "Deployment failed for ${target:-unknown}; previous commit: $old" >&2
    if [[ "$applied" == 1 ]]; then
        git reset --hard "$old"
        systemctl restart jingce.service
        echo "Restored previous version: $old" >&2
    fi
    [[ -z "$target" ]] || printf '%s\n' "$target" > "$STATE_DIR/rejected-commit"
    status failed || true
    exit "$code"
}
trap failed ERR

# Refuse to discard source changes made directly on the server.
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    echo 'Server source contains unpublished changes; automatic deployment stopped.' >&2
    status dirty
    exit 1
fi

timeout 60 git -c http.proxy= -c https.proxy= fetch "$REPOSITORY" main
target=$(git rev-parse FETCH_HEAD)
if [[ "$old" == "$target" ]]; then
    status synchronized
    exit 0
fi
if [[ -f "$STATE_DIR/rejected-commit" && "$(cat "$STATE_DIR/rejected-commit")" == "$target" ]]; then
    echo "Commit $target previously failed; waiting for a corrected commit." >&2
    exit 1
fi
git merge-base --is-ancestor "$old" "$target"

stage=$(mktemp -d "$STATE_DIR/stage.XXXXXXXX")
git archive "$target" | tar -x -C "$stage"
echo "Testing commit $target before updating the server"
status testing
(
    cd "$stage"
    if [[ -f package-lock.json ]]; then
        npm ci --ignore-scripts
    fi
    timeout 180 npm test
)

# Source updates never include runtime/, private settings, logs or local media.
printf '%s\n' "$old" > "$STATE_DIR/previous-commit"
status deploying
applied=1
git merge --ff-only "$target"
systemctl restart jingce.service

healthy=0
for attempt in $(seq 1 20); do
    if node --input-type=module -e 'const r=await fetch("http://127.0.0.1:18970/api/bootstrap",{signal:AbortSignal.timeout(2000)}); const b=await r.json(); if(!r.ok||b.appId!=="jingce-ad-studio")process.exit(1);' 2>/dev/null; then
        healthy=1
        break
    fi
    sleep 1
done
[[ "$healthy" == 1 ]]
[[ "$(git rev-parse HEAD)" == "$target" ]]
git diff --quiet HEAD
status synchronized
rm -f "$STATE_DIR/rejected-commit"
applied=0
echo "Deployment complete: $target"

# Keep the installed updater in sync; replace atomically for the next run.
install -m 755 tools/deploy/update-server.sh /usr/local/sbin/jingce-auto-deploy.next
mv /usr/local/sbin/jingce-auto-deploy.next /usr/local/sbin/jingce-auto-deploy

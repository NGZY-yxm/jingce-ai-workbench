#!/usr/bin/env bash
set -Eeuo pipefail
source_script=/opt/jingce-sync-validation/tools/deploy/update-server.sh
tmp=$(mktemp -d /tmp/jingce-deployment-test.XXXXXXXX)
trap 'if [[ "${KEEP_TEST_TMP:-0}" == 1 ]]; then echo "Test fixture retained at $tmp"; else rm -rf -- "$tmp"; fi' EXIT
git init --bare -q "$tmp/remote.git"
git init -q -b main "$tmp/source"
cd "$tmp/source"
git config user.name test
git config user.email test@example.invalid
mkdir -p tools/deploy
cp "$source_script" tools/deploy/update-server.sh
printf '%s\n' '{"scripts":{"test":"node -e \"process.exit(0)\""}}' > package.json
printf 'initial\n' > version.txt
git add .
git commit -qm initial
git remote add origin "$tmp/remote.git"
git push -q origin main
git --git-dir="$tmp/remote.git" symbolic-ref HEAD refs/heads/main
git clone -q "$tmp/remote.git" "$tmp/app"
mkdir -p "$tmp/state" "$tmp/mockbin"
sed "s|^REPOSITORY=.*|REPOSITORY=$tmp/remote.git|" "$source_script" > "$tmp/updater.sh"

cat > "$tmp/mockbin/node" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'http://127.0.0.1:18970/api/bootstrap'* ]]; then
    [[ "${FAIL_HEALTH:-0}" != 1 ]]
else
    exec /usr/bin/node "$@"
fi
EOF
cat > "$tmp/mockbin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$JINGCE_DEPLOY_STATE/restarts.log"
EOF
cat > "$tmp/mockbin/install" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$tmp/mockbin/mv" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'/usr/local/sbin/jingce-auto-deploy'* ]]; then exit 0; fi
exec /usr/bin/mv "$@"
EOF
cat > "$tmp/mockbin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/mockbin/"*
export PATH="$tmp/mockbin:$PATH" JINGCE_APP_DIR="$tmp/app" JINGCE_DEPLOY_STATE="$tmp/state"
run_update() { bash "$tmp/updater.sh" > "$tmp/run.log" 2>&1 || { local code=$?; cat "$tmp/run.log"; return "$code"; }; }
run_update
grep -q synchronized "$tmp/state/status.json"
echo 'PASS: unchanged commit remains synchronized'

printf 'new version\n' > version.txt
git add . && git commit -qm update && git push -q origin main
run_update
good=$(git rev-parse HEAD)
[[ "$(git -C "$tmp/app" rev-parse HEAD)" == "$good" ]]
[[ "$(cat "$tmp/app/version.txt")" == 'new version' ]]
echo 'PASS: successful tests deploy exact remote commit'

printf '%s\n' '{"scripts":{"test":"node -e \"process.exit(1)\""}}' > package.json
git add . && git commit -qm bad-tests && git push -q origin main
if run_update; then echo 'Expected failed tests to stop deployment'; exit 1; fi
[[ "$(git -C "$tmp/app" rev-parse HEAD)" == "$good" ]]
[[ "$(cat "$tmp/state/rejected-commit")" == "$(git rev-parse HEAD)" ]]
echo 'PASS: failed tests retain production and reject commit'

printf '%s\n' '{"scripts":{"test":"node -e \"process.exit(0)\""}}' > package.json
git add . && git commit -qm fixed-tests && git push -q origin main
export FAIL_HEALTH=1
if run_update; then echo 'Expected failed health check to roll back'; exit 1; fi
[[ "$(git -C "$tmp/app" rev-parse HEAD)" == "$good" ]]
grep -q 'Restored previous version' "$tmp/run.log"
unset FAIL_HEALTH
echo 'PASS: failed health check restores previous commit'

printf 'unpublished change\n' > "$tmp/app/version.txt"
if run_update; then echo 'Expected dirty working tree to stop deployment'; exit 1; fi
[[ "$(cat "$tmp/app/version.txt")" == 'unpublished change' ]]
grep -q dirty "$tmp/state/status.json"
echo 'PASS: unpublished server edits remain untouched'

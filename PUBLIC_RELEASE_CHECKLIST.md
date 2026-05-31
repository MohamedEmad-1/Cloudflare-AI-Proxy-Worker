# Public Release Checklist

Use this checklist before pushing the repository to a public GitHub repo.

## 1. Rotate Exposed Secrets

These values have been exposed during development and should be replaced before public release:

- GitHub Models token
- Cloudflare AI Gateway token
- Google AI Studio API keys
- Worker `MASTER_KEY`

Notes:

- The Worker `MASTER_KEY` has already been rotated in the current workspace and deployed Worker.
- Provider-issued secrets still must be rotated in their own dashboards or consoles.

## 2. Update Local Secrets After Rotation

After you generate new provider secrets, update your local `.dev.vars` file with the new values.

Files to keep aligned:

- local `.dev.vars`
- Cloudflare Worker secrets in dashboard

If you use the helper script, make sure `.dev.vars` includes:

- `MASTER_KEY`
- `CF_API_TOKEN`
- `GITHUB_TOKEN`
- `GEMINI_KEY_1` through `GEMINI_KEY_6`

Then upload them with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1
```

## 3. Verify No Secrets Are Tracked By Git

Run these checks before pushing:

```bash
git check-ignore -v .dev.vars
git ls-files --error-unmatch .dev.vars
git grep -n "AIzaSy\|github_pat_\|cfut_\|MASTER_KEY=" HEAD
```

Expected result:

- `.dev.vars` is ignored
- `.dev.vars` is not tracked
- `git grep` finds no real secret values in tracked files

## 4. Verify Public Files Only Use Placeholders

Check these files:

- [.dev.vars.example](.dev.vars.example)
- [README.md](README.md)
- [wrangler.jsonc](wrangler.jsonc)

Rules:

- No real secret values
- Only placeholder values in examples
- No pasted request headers with real credentials

## 5. Verify Runtime Config In Cloudflare

Plaintext variables:

- `CF_ACCOUNT_ID`
- `GATEWAY_NAME`

These may stay public in [wrangler.jsonc](wrangler.jsonc). They are identifiers, not secrets.

Secrets:

- `MASTER_KEY`
- `CF_API_TOKEN`
- `GITHUB_TOKEN`
- `GEMINI_KEY_1`
- `GEMINI_KEY_2`
- `GEMINI_KEY_3`
- `GEMINI_KEY_4`
- `GEMINI_KEY_5`
- `GEMINI_KEY_6`

## 6. Validate Locally

Run:

```bash
npm test -- --run
```

Optional local smoke test:

```bash
npm run dev
```

## 7. Validate The Deployed Worker

Run a smoke test against the deployed endpoint using your new `MASTER_KEY`:

```text
POST /v1/chat/completions
```

Test at least:

- `pool-flash`
- `pool-2.5-tools`
- `pool-lite`

## 8. Publish To GitHub

- Create the public repository
- Push the code
- Verify GitHub secret scanning reports no leaked credentials
- Add branch protection or CI later if needed

## 9. Post-Publish Check

- Confirm the public repo does not include `.dev.vars`
- Confirm the README setup steps are accurate
- Confirm clients like n8n still work with the deployed Worker
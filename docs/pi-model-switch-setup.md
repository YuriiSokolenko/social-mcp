# Pi Model Switch — one-time setup

The `Pi Model Switch` workflow (`.github/workflows/pi-model-switch.yml`) lets
you flip which GGUF nano's `hp-laguna` backend (llama-server on port 3009)
is actually serving — Laguna S 2.1 or Qwen 3.8 Flash Next — by running the
workflow from the GitHub Actions UI (`Run workflow` → pick `model`).

It reaches nano over SSH using a **dedicated, restricted key**: nano's
`authorized_keys` forces that key to run exactly
`infra/llama-gguf-experimental/switch-model.sh` (a copy is kept at
`infra/nano-model-switch/switch-model.sh` in this repo for review), which
only accepts the literal string `laguna` or `qwen` and refuses anything
else. Even if the private key leaked, it cannot run arbitrary commands on
nano — only stop/start these two model scripts.

This key generation and installation is **not automated** — it grants new
standing remote access, so it's deliberately a manual, one-time step you run
yourself. Do this once:

## 1. Generate a dedicated keypair (no passphrase — it runs non-interactively in CI)

```bash
ssh-keygen -t ed25519 -N "" -C "ci-model-switch@social-mcp" -f ~/.ssh/nano-model-switch
```

## 2. Put the wrapper script on nano

```bash
scp infra/nano-model-switch/switch-model.sh nano:/home/yurasik/infra/llama-gguf-experimental/switch-model.sh
ssh nano 'chmod +x /home/yurasik/infra/llama-gguf-experimental/switch-model.sh'
```

## 3. Install the restricted public key on nano

```bash
LINE="command=\"/home/yurasik/infra/llama-gguf-experimental/switch-model.sh\",no-agent-forwarding,no-port-forwarding,no-x11-forwarding,no-pty $(cat ~/.ssh/nano-model-switch.pub)"
ssh nano "cat >> ~/.ssh/authorized_keys" <<< "$LINE"
```

Verify the line landed correctly (should show `command="..."` in front of
the key, on nano):

```bash
ssh nano "tail -1 ~/.ssh/authorized_keys"
```

## 4. Store the private key as a GitHub Actions secret

```bash
gh secret set NANO_MODEL_SWITCH_KEY --repo YuriiSokolenko/social-mcp < ~/.ssh/nano-model-switch
```

GitHub never lets you read a secret back after this, so keep
`~/.ssh/nano-model-switch` around locally if you want a backup — or just
regenerate and re-run steps 1/3/4 later to rotate it (remove the old line
from nano's `authorized_keys` when you do).

## 5. Test it

```bash
gh workflow run "Pi Model Switch" --repo YuriiSokolenko/social-mcp -f model=laguna
```

Watch it in the Actions tab. On success it also sets the `PI_MODEL` repo
variable, which every other Pi workflow's `model` default falls back to for
automatic (non-manual) runs.

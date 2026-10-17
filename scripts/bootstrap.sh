#!/usr/bin/env bash
# Creates .env with real generated secrets, leaving your API keys empty to fill in.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] && { echo ".env already exists — not touching it."; exit 0; }

cp .env.example .env

python3 - <<'PY'
import re, secrets, string, pathlib
p = pathlib.Path(".env")
s = p.read_text()
def rnd(n):
    a = string.ascii_letters + string.digits
    return "".join(secrets.choice(a) for _ in range(n))
s = re.sub(r"^POSTGRES_PASSWORD=.*$",  f"POSTGRES_PASSWORD={rnd(28)}", s, flags=re.M)
s = re.sub(r"^N8N_ENCRYPTION_KEY=.*$",  f"N8N_ENCRYPTION_KEY={secrets.token_hex(32)}", s, flags=re.M)
s = re.sub(r"^N8N_BASIC_AUTH_PASSWORD=.*$", f"N8N_BASIC_AUTH_PASSWORD={rnd(16)}", s, flags=re.M)
s = re.sub(r"^WHATSAPP_VERIFY_TOKEN=.*$", f"WHATSAPP_VERIFY_TOKEN={rnd(20)}", s, flags=re.M)
p.write_text(s)
print("wrote .env")
PY

chmod 600 .env
mkdir -p secrets
echo "Next: put your GEMINI_API_KEY into .env (https://aistudio.google.com/apikey)"
echo "Admin password for n8n: $(grep '^N8N_BASIC_AUTH_PASSWORD=' .env | cut -d= -f2)"

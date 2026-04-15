FROM node:20-slim

# ─── System deps ─────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# ─── GitHub CLI ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# ─── Roo CLI ──────────────────────────────────────────────────────────────────
RUN curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | bash

ENV PATH="/root/.local/bin:$PATH"

# ─── App ──────────────────────────────────────────────────────────────────────
WORKDIR /app

COPY package.json ./
RUN npm install --only=production

COPY scripts/ ./scripts/
COPY server.js entrypoint.sh ./

RUN chmod +x ./scripts/roo-local.sh ./entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.js"]

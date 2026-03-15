FROM node:20-slim

# Install dependencies for Roo (curl for install, git for workspace operations)
RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/*

# Install Roo Code CLI via the official script
RUN curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh

# Add the roo binary to the path
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# This keeps the container running. 
# You can change this to a specific 'roo' command if you want it to run a task on boot.
CMD ["tail", "-f", "/dev/null"]

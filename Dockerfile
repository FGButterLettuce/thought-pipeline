FROM node:20-slim

# Install Python, curl, and other deps
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment for edge-tts
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install edge-tts
RUN pip install edge-tts

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy app code
COPY . .

# Create directories with proper permissions
RUN mkdir -p audio recordings data && chmod 755 audio recordings data

# Create non-root user with different UID
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

CMD ["node", "src/server.js"]

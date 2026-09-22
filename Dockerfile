FROM ghcr.io/astral-sh/uv:0.10.6 AS uv
FROM node:22-bookworm-slim
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY solver/pyproject.toml solver/uv.lock ./solver/
RUN uv sync --frozen --project solver --python 3.12
COPY . .
RUN npm run build && uv run --frozen --project solver python -c 'from ortools.sat.python import cp_model'
RUN chown -R node:node /app /opt/python
USER node
ENV HOST=0.0.0.0
CMD ["node", "--import", "tsx", "src/server.ts"]

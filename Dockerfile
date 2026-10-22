# The container is an optional deployment layer, not a model-code sandbox.
FROM python:3.12-slim
WORKDIR /app
COPY . .
# Only disposable workspace data needs write access for the unprivileged user.
RUN mkdir -p /app/.workspaces && chown 10001:10001 /app/.workspaces
USER 10001:10001
EXPOSE 8080
CMD ["python", "-B", "server.py", "--host", "0.0.0.0", "--port", "8080"]

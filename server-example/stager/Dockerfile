FROM denoland/deno:2.1.4

WORKDIR /app
COPY main.ts /app/main.ts
RUN deno cache main.ts

CMD ["deno", "run", "--allow-read", "--allow-write", "--allow-env", "main.ts"]

# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx nx run-many --target=build --projects=shell,page1,page2 --configuration=production --parallel=3

# Stage 2: Serve
FROM nginx:alpine AS runner
COPY nginx/nginx.conf /etc/nginx/nginx.conf
RUN sed -i 's|application/javascript\s*js;|application/javascript js mjs;|' /etc/nginx/mime.types
COPY --from=builder /app/dist/apps/shell /usr/share/nginx/html/shell
COPY --from=builder /app/dist/apps/page1 /usr/share/nginx/html/page1
COPY --from=builder /app/dist/apps/page2 /usr/share/nginx/html/page2
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

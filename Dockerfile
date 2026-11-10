# Container image for hosted environments (the DigitalOcean staging demo, docs/STAGING.md): the
# Next.js server plus the tsx scripts it is operated with (staging:release, staging:smoke, worker).
FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start:server"]

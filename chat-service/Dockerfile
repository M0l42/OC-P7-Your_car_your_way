# syntax=docker/dockerfile:1
# Build context: repository root (needs the parent pom and the Maven Wrapper).
#   docker build -f chat-service/Dockerfile .

FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /src
COPY mvnw pom.xml ./
COPY .mvn .mvn
COPY chat-service/pom.xml chat-service/pom.xml
COPY auth-stub/pom.xml auth-stub/pom.xml
COPY chat-service/src chat-service/src
RUN --mount=type=cache,target=/root/.m2 \
    ./mvnw -B -q -pl chat-service -am -DskipTests package \
 && java -Djarmode=tools -jar chat-service/target/chat-service-*.jar extract --layers --launcher --destination /extracted

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S app && adduser -S -G app -H -u 10001 app
WORKDIR /app
# Layers ordered from least to most frequently changing, for better image caching.
COPY --from=build /extracted/dependencies/ ./
COPY --from=build /extracted/spring-boot-loader/ ./
COPY --from=build /extracted/snapshot-dependencies/ ./
COPY --from=build /extracted/application/ ./
USER app
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
HEALTHCHECK --interval=5s --timeout=3s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/actuator/health/readiness >/dev/null || exit 1
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]

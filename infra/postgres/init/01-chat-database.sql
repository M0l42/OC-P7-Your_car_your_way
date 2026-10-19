-- Dev-only bootstrap: the chat service owns its own logical database and credentials (premise 1).
-- Schema is created by Flyway in chat-service, not here.
CREATE ROLE chat LOGIN PASSWORD 'chat';
CREATE DATABASE chat OWNER chat;

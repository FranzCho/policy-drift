CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  phone VARCHAR(20),
  email_verified_at TIMESTAMP NULL,
  email_template_id INT
);

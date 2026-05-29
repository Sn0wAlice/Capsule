/**
 * Helper to set session data via the test endpoint.
 * Returns an agent with the session cookie attached.
 */
const request = require('supertest');

const DEFAULT_USER = {
  id: 1,
  username: 'testuser',
  role: 'user',
  theme: 'dark',
  default_view: 'grid',
};

const ADMIN_USER = {
  id: 2,
  username: 'admin',
  role: 'admin',
  theme: 'dark',
  default_view: 'grid',
};

async function loginAs(app, user = DEFAULT_USER) {
  const agent = request.agent(app);
  await agent.post('/test/set-session').send({ user });
  return agent;
}

async function loginAsAdmin(app) {
  return loginAs(app, ADMIN_USER);
}

module.exports = { loginAs, loginAsAdmin, DEFAULT_USER, ADMIN_USER };

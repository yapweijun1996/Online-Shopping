import assert from 'node:assert/strict';

export async function signInToProducts(page, { origin, config }) {
  await page.goto(`${origin}/seller/#products`);
  await page.locator('#username').fill(config.username);
  await page.locator('#password').fill(config.password);
  const [response] = await Promise.all([
    page.waitForResponse(result => result.url() === `${origin}/api/v1/seller/session` && result.request().method() === 'POST'),
    page.locator('#login-submit').click(),
  ]);
  assert.equal(response.status(), 200, 'local fixture sign-in succeeds');
}

// Block external traffic and let callers hold individual local list requests.
export async function controlProductResponses(context, { origin }) {
  const gates = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/v1/seller/products') {
      const index = gates.findIndex(gate => gate.matches(url.searchParams));
      if (index !== -1) {
        const [gate] = gates.splice(index, 1);
        gate.requested.resolve();
        if (await gate.outcome.promise) return route.abort();
      }
    }
    return route.continue();
  });
  return (matches = () => true) => {
    const requested = Promise.withResolvers();
    const outcome = Promise.withResolvers();
    gates.push({ matches, requested, outcome });
    return { requested: requested.promise, release: () => outcome.resolve(false), fail: () => outcome.resolve(true) };
  };
}

import assert from 'node:assert/strict';
import { isMarker, markers } from '../core/markers.mjs';
// One temporary grant in the existing isolated synthetic identity scheme. No global role changes.
function permissionFixture(api, identity, verifyProject, expectedGrant) {
  const path = `/permissionscheme/${identity.scheme.id}`;
  const canonical = (p) => ({
    id: String(p.id),
    permission: p.permission,
    holder: { type: p.holder?.type, parameter: p.holder?.parameter ?? p.holder?.value },
  });
  const permissions = async () => {
    const value = await api(`${path}/permission`);
    assert.ok(Array.isArray(value?.permissions));
    return value.permissions.map(canonical).sort((a, b) => a.id.localeCompare(b.id));
  };
  async function isolated() {
    await verifyProject();
    assert.ok(isMarker((await api(path)).description, markers.identityProject));
    let start = 0,
      found = 0;
    for (let i = 0; i < 20; i++) {
      const page = await api(
        `/project/search?status=live&status=archived&startAt=${start}&maxResults=100`,
      );
      assert.ok(Array.isArray(page?.values));
      for (const project of page.values) {
        const scheme = await api(`/project/${project.id}/permissionscheme`);
        if (String(scheme?.id) === identity.scheme.id) {
          assert.equal(
            String(project.id),
            identity.project.id,
            'Permission scheme is shared; refuse fixture mutation',
          );
          found++;
        }
      }
      if (page.isLast) {
        assert.equal(found, 1);
        return;
      }
      assert.ok(page.values.length > 0);
      start += page.values.length;
    }
    throw Error('Space inventory limit; cannot prove scheme isolation');
  }
  function checkIntent(expected) {
    assert.deepEqual(expected.grant, expectedGrant);
    assert.ok(Array.isArray(expected.before));
    assert.ok(
      !expected.before.some(
        (p) =>
          p.permission === expectedGrant.permission &&
          p.holder.type === 'user' &&
          p.holder.parameter === expectedGrant.holder.parameter,
      ),
    );
  }
  const adapter = {
    async create(expected) {
      checkIntent(expected);
      await isolated();
      assert.deepEqual(await permissions(), expected.before);
      return api(`${path}/permission`, 'POST', expectedGrant);
    },
    read: (id) => api(`${path}/permission/${id}`),
    async find(expected) {
      checkIntent(expected);
      const beforeIds = new Set(expected.before.map((p) => p.id));
      return (await permissions()).filter(
        (p) =>
          !beforeIds.has(p.id) &&
          p.permission === expectedGrant.permission &&
          p.holder.type === 'user' &&
          p.holder.parameter === expectedGrant.holder.parameter,
      );
    },
    async verify(entry, value) {
      checkIntent(entry.expected);
      await verifyProject();
      assert.ok(isMarker((await api(path)).description, markers.identityProject));
      assert.deepEqual(canonical(value ?? (await adapter.read(entry.id))), {
        id: entry.id,
        ...expectedGrant,
      });
      assert.deepEqual(
        (await permissions()).filter((p) => p.id !== entry.id),
        entry.expected.before,
      );
    },
    async remove(entry) {
      await isolated();
      await adapter.verify(entry);
      await api(`${path}/permission/${entry.id}`, 'DELETE');
      assert.deepEqual(await permissions(), entry.expected.before);
    },
  };
  return {
    adapter,
    async intent() {
      return { grant: structuredClone(expectedGrant), before: await permissions() };
    },
  };
}

export function projectAdminFixture(api, identity, verifyProject) {
  return permissionFixture(api, identity, verifyProject, {
    permission: 'ADMINISTER_PROJECTS',
    holder: { type: 'user', parameter: identity.actors.member },
  });
}

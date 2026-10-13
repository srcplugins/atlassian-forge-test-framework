import { readFileSync } from 'node:fs';
import { identityProjectKey, siteFor } from '../core/config.mjs';
import { activeTarget } from '../core/target.mjs';
export function validateIdentityFixture(value, host) {
  if (
    host !== siteFor('primary') ||
    value?.site !== `https://${host}` ||
    value?.project?.key !== identityProjectKey() ||
    !/^[1-9]\d*$/.test(String(value.project.id)) ||
    !/^[1-9]\d*$/.test(String(value.scheme?.id))
  )
    throw Error('Owned identity fixture configuration required for this site.');
  const actors = value.actors;
  if (
    !actors ||
    ['owner', 'member', 'restricted'].some(
      (role) => typeof actors[role] !== 'string' || !actors[role].trim(),
    ) ||
    new Set(Object.values(actors)).size !== 3
  )
    throw Error('Three distinct pinned identity accounts required.');
  return {
    site: value.site,
    project: { id: String(value.project.id), key: value.project.key },
    scheme: { id: String(value.scheme.id) },
    actors,
  };
}
export function identityFixture() {
  let value;
  try {
    value = JSON.parse(readFileSync(`${activeTarget().directory}/identity-fixture.json`, 'utf8'));
  } catch {
    throw Error(
      'Identity prerequisites missing: configure the site-scoped e2e/identity-fixture.json and saved admin/member/restricted sessions.',
    );
  }
  return validateIdentityFixture(value, activeTarget().host);
}
export function verifyIdentityPermissions(permissions, role) {
  if (!['owner', 'member', 'restricted'].includes(role)) throw Error('Unknown test identity role.');
  if (
    role === 'owner' &&
    permissions?.ADMINISTER?.havePermission !== true &&
    permissions?.ADMINISTER_PROJECTS?.havePermission !== true
  )
    throw Error('Identity setup actor requires administration.');
  const expected = {
    BROWSE_PROJECTS: true,
    EDIT_ISSUES: true,
    ADD_COMMENTS: role !== 'restricted',
  };
  if (role !== 'owner') Object.assign(expected, { ADMINISTER_PROJECTS: false, ADMINISTER: false });
  for (const [key, value] of Object.entries(expected))
    if (permissions?.[key]?.havePermission !== value)
      throw Error(`Identity prerequisite: unexpected ${key} for ${role}.`);
}

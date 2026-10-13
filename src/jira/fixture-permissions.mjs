// Use before any disposable fixture write, including manually exercised Rovo journeys.
// Creation permission alone does not imply that teardown can delete the artifacts.
export async function checkFixturePermissions(api, projectId) {
  if (!/^[1-9][0-9]*$/.test(String(projectId))) throw Error('Invalid fixture project ID');
  const required = ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'DELETE_ISSUES'];
  const response = await api(
    `/mypermissions?projectId=${projectId}&permissions=${required.join(',')}`,
  );
  for (const name of required)
    if (response?.permissions?.[name]?.havePermission !== true)
      throw Error(`Fixture permission missing: ${name}`);
}

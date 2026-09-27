/** Infrastructure that keeps profile management reachable through its current host and client. */
const managementModules = new Set([
  '@shres-code/cordis-plugin-loader', '@shres-code/cordis-plugin-include',
  '@shres-code/cordis-plugin-hmr', '@shres-code/cordis-plugin-timer',
  '@shres-code/shres-code-host-plugin-admin', '@shres-code/shres-code-host-plugin-inventory',
  '@shres-code/shres-code-api-gateway', '@shres-code/shres-code-api-remotes',
  '@shres-code/shres-code-host-apiproxy', '@shres-code/shres-code-typert-loader',
  '@shres-code/shres-code-typert-registry', '@shres-code/shres-code-host-webserver',
  '@shres-code/shres-code-web-app', '@shres-code/shres-code-web-app/startup',
  '@shres-code/shres-code-host-frontend-static', '@shres-code/shres-code-client-modules',
  '@shres-code/shres-code-client-connection', '@shres-code/shres-code-client-hmr',
  '@shres-code/shres-code-client-runtime', '@shres-code/shres-code-client-locale',
  '@shres-code/shres-code-client-ui-slots', '@shres-code/shres-code-client-ui-layout',
  '@shres-code/shres-code-client-ui-settings', '@shres-code/shres-code-client-ui-settings-general',
  '@shres-code/shres-code-client-ui-settings-plugins', '@shres-code/shres-code-client-ui-settings-plugin-inventory',
  '@shres-code/shres-code-cordis-host-runner', '@shres-code/shres-code-cordis-client-runner',
])

/**
 * Test whether a module is required by the shared plugin-management path.
 * @param moduleName - exact package specifier from a composition row.
 * @returns whether its activation is protected by the manager.
 */
export function isProfileManagementModule(moduleName: string): boolean {
  return managementModules.has(moduleName)
}

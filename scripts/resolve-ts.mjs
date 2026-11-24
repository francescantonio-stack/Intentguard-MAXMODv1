/** ESM resolve hook: add .ts to relative extensionless specifiers (for node --experimental-strip-types). */
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[A-Za-z0-9]+$/.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

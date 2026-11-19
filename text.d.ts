// Bun embeds these files in the compiled binary.
declare module "*.md" {
  const text: string;
  export default text;
}

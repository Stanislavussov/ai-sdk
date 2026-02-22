# Team Standards

## Code Style

- Functional components, TypeScript strict
- Named exports, no default exports

## Git

- Branch: feature/description, fix/description
- Commits: Conventional Commits

## Testing

- Min 80% coverage
- Unit + integration for API

## Terminal

When the user asks to run a command (dev server, build, or any long-running/interactive process), use `/terminal`:

```
/terminal <command>
```

This opens a new terminal tab where the command runs interactively. Do NOT use the bash tool for interactive or long-running commands.

# Release Scripts Diagrams

This directory contains Mermaid diagram files (`.mmd`) that visualize the architecture and workflows of the @ucdjs/release-scripts project.

## Recommended Viewing Order

For the best understanding of the system, view the diagrams in this order:

### 1. Architecture Overview
Start with the overall architecture to understand how services interact:

**[service-dependency-graph.mmd](./service-dependency-graph.mmd)**
- Shows all 7 services and their dependencies
- Illustrates how configuration flows into services
- Displays which services are used by each workflow (verify, prepare, publish)
- Color-coded by service type

### 2. Supporting Algorithms
Before diving into workflows, understand the key algorithms:

**[version-bump-calculation.mmd](./version-bump-calculation.mmd)**
- How version bumps are calculated from conventional commits
- Shows the priority: breaking changes → major, features → minor, fixes → patch
- Includes version override handling

**[commit-attribution-flow.mmd](./commit-attribution-flow.mmd)**
- Sophisticated global commit attribution algorithm
- Three modes: none, all, dependencies
- Timestamp-based filtering to prevent double-counting
- Critical for understanding how commits are attributed in monorepos

### 3. Main Workflows
Now examine the three main workflows in order of complexity:

**[verify-workflow.mmd](./verify-workflow.mmd)** (Implemented)
- Verifies that release branch matches expected state
- Loads overrides, discovers packages, calculates expected versions
- Compares expected vs actual versions/dependencies
- Sets GitHub commit status (success/failure)
- **Use case**: CI/CD validation of release PRs

**[prepare-workflow.mmd](./prepare-workflow.mmd)** (Implemented)
- Prepares releases by calculating and applying version updates
- Updates package.json files in topological order
- Supports dry-run mode
- Shows future enhancements (PR creation, changelog generation)
- **Use case**: Local release preparation before creating/updating PR

**[publish-workflow.mmd](./publish-workflow.mmd)** (Planned)
- Publishing packages to NPM in topological order
- Parallel publishing within dependency levels
- NPM version existence checking
- Git tag creation after successful publish
- **Use case**: Automated NPM publishing from CI/CD

## Diagram Files

| File | Type | Purpose | Status |
|------|------|---------|--------|
| `service-dependency-graph.mmd` | Architecture | Service dependencies and workflow usage | Current |
| `version-bump-calculation.mmd` | Algorithm | Version bump logic from commits | Current |
| `commit-attribution-flow.mmd` | Algorithm | Global commit attribution | Current |
| `verify-workflow.mmd` | Workflow | Release branch verification | Implemented |
| `prepare-workflow.mmd` | Workflow | Release preparation | Implemented |
| `publish-workflow.mmd` | Workflow | NPM publishing | Planned |

## Viewing the Diagrams

### Online (GitHub)
GitHub automatically renders `.mmd` files when you view them in the web interface. Simply click on any diagram file above.

### Locally with VS Code
Install the [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) extension to view diagrams in markdown preview.

### Generate PNG/SVG Images
Use the [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) to generate images:

```bash
# Install mermaid-cli
npm install -g @mermaid-js/mermaid-cli

# Generate PNG
mmdc -i verify-workflow.mmd -o verify-workflow.png

# Generate SVG
mmdc -i verify-workflow.mmd -o verify-workflow.svg

# Generate all diagrams
for file in *.mmd; do mmdc -i "$file" -o "${file%.mmd}.png"; done
```

### Online Editor
Copy and paste diagram content into the [Mermaid Live Editor](https://mermaid.live/) for interactive viewing and editing.

## Color Coding

The diagrams use consistent color coding:

### Workflow Diagrams
- **Green** (`#e1f5e1`): Start/Success states
- **Red** (`#ffe1e1`, `#ffcccc`): Error states and exit failures
- **Yellow** (`#fff4e1`): Decision points and important checks
- **Blue dashed** (`#e1f0ff` with dashed border): Planned/future features
- **Light green** (`#d4edda`): Successful operations
- **Light red** (`#f8d7da`): Failed operations
- **Gray** (`#f0f0f0`): Skip/neutral operations

### Service Dependency Graph
- **Light blue** (`#e1f0ff`): Configuration
- **Light red** (`#ffe1e1`): External services (Git, GitHub, NPM)
- **Light green** (`#e1ffe1`): Core workspace service
- **Yellow** (`#fff4e1`): Calculation services
- **Purple** (`#f0e1ff`): Update services
- **Gray** (`#f0f0f0`): Helper utilities
- **Green** (`#d4edda`): Implemented workflows
- **Blue dashed**: Planned workflows

### Version Bump Calculation
- **Red** (`#ffcccc`): Major bump
- **Yellow** (`#fff4cc`): Minor bump
- **Green** (`#ccffcc`): Patch bump
- **Gray** (`#f0f0f0`): No bump
- **Blue** (`#e1f0ff`): Override

## Integration

These diagrams are referenced in the main project documentation:
- **[AGENTS.md](../../AGENTS.md)**: Complete architecture guide with inline diagram previews
- Each workflow section in AGENTS.md links to the corresponding diagram file

## Updating Diagrams

When updating diagrams:

1. Edit the `.mmd` file directly
2. Test the diagram syntax at [Mermaid Live Editor](https://mermaid.live/)
3. Ensure color coding follows the conventions above
4. Update both the `.mmd` file and the corresponding inline diagram in AGENTS.md
5. Consider regenerating PNG/SVG images if they're used elsewhere

## Contributing

When adding new diagrams:

1. Follow the naming convention: `kebab-case.mmd`
2. Add the diagram to this README with description and purpose
3. Reference it from AGENTS.md if applicable
4. Use consistent color coding (see above)
5. Include clear labels and decision points
6. Test rendering on GitHub before committing

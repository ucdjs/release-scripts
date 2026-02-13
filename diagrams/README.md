# Release Scripts Architecture Diagrams

This directory contains comprehensive mermaid diagrams documenting the @ucdjs/release-scripts architecture.

## Diagrams Overview

1. **01-overall-architecture.mmd** - High-level system architecture showing all layers and components
2. **02-service-dependencies.mmd** - Effect Layer composition and service dependency injection
3. **03-verify-workflow.mmd** - Detailed data flow for the verify() operation
4. **04-prepare-workflow.mmd** - Detailed data flow for the prepare() operation
5. **05-publish-workflow.mmd** - Detailed data flow for the publish() operation
6. **06-global-commit-attribution.mmd** - How global commits are attributed to packages
7. **07-package-discovery.mmd** - Package discovery and filtering logic
8. **08-version-calculation.mmd** - Version bump calculation algorithm
9. **09-error-hierarchy.mmd** - Error type hierarchy using Effect's Data.TaggedError
10. **10-data-models.mmd** - Entity relationship diagram of core data types
11. **11-dependency-graph.mmd** - Topological sorting algorithm for package ordering
12. **12-file-structure.mmd** - Project file organization and structure

## Usage

These diagrams can be rendered using:
- [Mermaid Live Editor](https://mermaid.live)
- GitHub (native mermaid support in markdown)
- VS Code with Mermaid extensions
- Documentation generators

## Key Architectural Patterns

- **Effect-TS**: Functional effect system for async/error handling
- **Service Pattern**: Effect.Service classes with dependency injection
- **Layer Composition**: Services composed via Effect.Layer
- **Tagged Errors**: Type-safe error handling with Data.TaggedError
- **Schema Validation**: Runtime validation using Effect.Schema

## Workflow Summary

- **verify()**: Validates release branch matches expected versions
- **prepare()**: Calculates versions, updates package.json, creates PR
- **publish()**: Publishes to NPM, creates tags in topological order

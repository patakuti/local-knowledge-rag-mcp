# Contributing to Local Knowledge RAG MCP Server

Thank you for your interest in contributing!

## Maintainer Availability

Please note that this project is maintained on a limited-time basis.

- Pull Request reviews may take several weeks to a month
- Bug reports are welcome, but immediate responses cannot be guaranteed
- For significant feature additions, please propose and discuss in an Issue first
- Security-related issues will be prioritized and addressed promptly

## How to Contribute

### Reporting Bugs

When reporting bugs, please include:

- Clear description of the issue
- Steps to reproduce
- Environment information (OS, Node.js version, etc.)
- Relevant logs or error messages
- Expected vs. actual behavior

### Suggesting Enhancements

When suggesting enhancements:

- Check existing Issues first to avoid duplicates
- Clearly describe the use case and benefits
- Consider backward compatibility
- Provide examples or mockups if applicable

### Pull Requests

We welcome pull requests! To increase the chance of acceptance:

- Include test cases demonstrating the fix or feature
- Update documentation as needed
- Follow the existing code style and conventions
- Write clear and descriptive commit messages
- Reference any related Issues

## Development Setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/yourusername/local-knowledge-rag-mcp.git
   cd local-knowledge-rag-mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Test your changes:
   ```bash
   npm test
   ```

## Coding Standards

- **TypeScript**: Strict mode enabled
- **Linting**: ESLint configuration must be followed
- **Naming**: Meaningful variable and function names
- **Documentation**: English comments and documentation
- **Error Handling**: Clear error messages and proper exception handling

## Testing Guidelines

- Test with multiple embedding providers (OpenAI, Ollama, OpenAI-compatible)
- Verify backward compatibility
- Test edge cases and error scenarios
- Document test procedures in your PR

## Code of Conduct

- Be respectful and constructive in all interactions
- Focus on technical aspects and the problem at hand
- Welcome diverse perspectives and backgrounds
- No harassment or discriminatory language

## Questions?

If you have questions:

- Check the [README.md](README.md) for general information
- Review the [Troubleshooting](README.md#troubleshooting) section
- Open a GitHub Issue with your question tagged as `[question]`

Thank you for helping to improve Local Knowledge RAG MCP Server!

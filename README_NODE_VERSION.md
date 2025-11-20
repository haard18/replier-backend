# Node.js Version Requirement

This project requires **Node.js 20 or higher** to run.

## Why Node.js 20+?

The `@supabase/supabase-js` package uses `undici` which requires the `File` API that was introduced in Node.js 20.

## How to Upgrade

### Using NVM (Node Version Manager)

```bash
# Install Node.js 20
nvm install 20

# Use Node.js 20
nvm use 20

# Verify version
node --version  # Should show v20.x.x
```

### Using Homebrew (macOS)

```bash
# Update Homebrew
brew update

# Install Node.js 20
brew install node@20

# Link it
brew link node@20

# Verify version
node --version
```

### Using Official Installer

Download and install from: https://nodejs.org/en/download/

Choose the **LTS version** (currently v20.x.x or higher)

## Deployment

### Railway/Render/Heroku

Add this to your deployment settings:

```
NODE_VERSION=20.11.0
```

Or use the `.nvmrc` file that's already in this directory.

### Docker

Use Node.js 20 base image:

```dockerfile
FROM node:20-alpine
```

## Verifying Your Setup

After upgrading, reinstall dependencies:

```bash
# Remove old node_modules
rm -rf node_modules package-lock.json

# Reinstall with Node.js 20
npm install

# Start the server
npm start
```

You should no longer see the `File is not defined` error.

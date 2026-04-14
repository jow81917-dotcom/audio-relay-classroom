# Use official Node.js 20 Alpine
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json & package-lock.json
COPY package*.json ./

# Install only production dependencies (faster & smaller)
RUN npm install --production

# Copy the rest of the project
COPY . .

# Expose port 3000
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
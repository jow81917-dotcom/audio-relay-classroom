# Dockerfile
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package.json ./
RUN npm install

# Copy the rest of the project
COPY . .

# Expose the port used by your server
EXPOSE 3000

# Start the Node.js server
CMD ["node", "server.js"]
#!/bin/bash
# Setup MongoDB as a replica set for Prisma

echo "Setting up MongoDB replica set..."

# Backup original config
sudo cp /etc/mongod.conf /etc/mongod.conf.backup

# Add replica set configuration
sudo tee -a /etc/mongod.conf > /dev/null << 'EOF'

# Replication for Prisma
replication:
  replSetName: "rs0"
EOF

echo "Configuration updated. Restarting MongoDB..."

# Restart MongoDB
sudo systemctl restart mongod || sudo systemctl restart mongodb

# Wait for MongoDB to start
sleep 3

# Initialize replica set
echo "Initializing replica set..."
mongo --eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "localhost:27017"}]})'

echo ""
echo "MongoDB replica set setup complete!"
echo "You can now run: npx prisma db seed"

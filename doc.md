# FanVault v2 — Cloud-Native 3-Microservice AWS Architecture

Welcome to **FanVault v2**, a production-grade, highly available, secure, and auto-scaling e-commerce platform for fan merchandise. 

This repository documents the complete end-to-end infrastructure, application deployment, networking, and security architecture of the platform. By following this guide, anyone with basic AWS experience will be able to replicate and deploy this system from scratch.

---

## 1. Architectural Blueprint

FanVault v2 consolidates a legacy 6-microservice structure into **3 independently deployable services** running on a secure, cross-region virtual private cloud network:

```
Region: us-east-1 (N. Virginia)                  Region: ap-south-1 (Mumbai)
┌──────────────────────────────────────────────┐ ┌────────────────────────────────┐
│ PRIMARY APPLICATION VPC (10.0.0.0/16)        │ │ DATABASE VPC (10.1.0.0/16)     │
│                                              │ │                                │
│ [ Public Subnets ]                           │ │                                │
│   ├─ Application Load Balancer               │ │                                │
│   ├─ Public NAT Gateway                      │ │                                │
│   └─ Public Bastion Host                     │ │                                │
│                                              │ │                                │
│ [ Private Subnets ]                          │ │                                │
│   ├─ Nginx / React SPA ASG (Port 80)         │ │                                │
│   ├─ Identity Service ASG (Port 3001)  ──────┼─┼─► [ VPC Peering (pcx) ]        │
│   └─ Commerce Service ASG (Port 3002)  ──────┼─┼─►   (AWS private backbone)     │
│                                              │ │     │                          │
│ [ Route53 Private Hosted Zone ]              │ │     ▼                          │
│   └─ db.fanvault.internal ───────────────────┼─┼─► [ MongoDB EC2 :27017 ]       │
│                                              │ │   (Private IP: 10.1.31.100)    │
└──────────────────────────────────────────────┘ └────────────────────────────────┘
```
<img width="3075" height="3263" alt="architecture png" src="https://github.com/user-attachments/assets/3fbbf997-773c-4d25-903a-7ec511e4112f" />
### Core Architecture Specifications

| Resource / Layer | Region | IP Range / CIDR | Details |
|---|---|---|---|
| **Primary VPC** | `us-east-1` (N. Virginia) | `10.0.0.0/16` | Hosts ALB, NAT, Bastion, Nginx Frontend ASG, Identity ASG, Commerce ASG. |
| **Database VPC** | `ap-south-1` (Mumbai) | `10.1.0.0/16` | Enclave VPC hosting the MongoDB database server. Completely isolated from the internet. |
| **VPC Peering** | Cross-Region | `pcx-xxxxx` | Private peered link connecting N. Virginia and Mumbai VPCs over AWS private backbone. |
| **Private DNS** | Route53 PHZ | `fanvault.internal` | Internal DNS resolving `db.fanvault.internal` $\rightarrow$ `10.1.31.100` across regions. |
| **Frontend ASG** | `us-east-1` | `10.0.11.0/24` (1a) <br> `10.0.12.0/24` (1b) | Runs static compiled React SPA hosted on Nginx (Port 80). |
| **Backend ASGs** | `us-east-1` | `10.0.21.0/24` (1a) <br> `10.0.22.0/24` (1b) | Identity Service (Port 3001) & Commerce Service (Port 3002). |
| **MongoDB EC2** | `ap-south-1` | `10.1.31.0/24` (1a) | Natively installed MongoDB 7.0 on Ubuntu 22.04 LTS (`t3.medium`). |

---

## 2. Security Groups Rule Matrix

To enforce a **defense-in-depth** security model, security groups are chained logically (instances accept connections exclusively from the security group of the resource directly upstream):

| Security Group Name | VPC / Region | Inbound Allowed Port/Protocol | Allowed Source | Architectural Rationale |
|---|---|---|---|---|
| **`fanvault-alb-sg`** | `us-east-1` | `TCP 80` (HTTP)<br>`TCP 443` (HTTPS) | `0.0.0.0/0` (Internet) | Public-facing edge ingress. Terminates TLS using ACM wildcard certificate. |
| **`fanvault-frontend-sg`** | `us-east-1` | `TCP 80` | `fanvault-alb-sg` | Nginx servers hosting React static files. Blocks direct internet access. |
| **`fanvault-backend-sg`** | `us-east-1` | `TCP 3001` (Identity)<br>`TCP 3002` (Commerce) | `fanvault-alb-sg` | Node.js Express backend servers. Only accepts API requests routed via the ALB. |
| **`fanvault-db-sg`** | `ap-south-1` | `TCP 27017` (MongoDB) | `10.0.0.0/16` (Primary VPC CIDR) | MongoDB isolated enclave. Accepts database traffic solely from peered VPC networks. |
| **`fanvault-bastion-sg`** | `us-east-1` | `TCP 22` (SSH) | *Your Administrator Public IP* | Gatekeeper for administrative SSH connections. |

---

## 3. Step-by-Step Infrastructure Provisioning

Follow these steps sequentially to build the cross-region architecture.

### STEP 1: Deploy Networking (Part A: N. Virginia)
*Switch your AWS Management Console region to **`us-east-1` (N. Virginia)**.*

1. **Create the Primary VPC**:
   - Go to **VPC Console** $\rightarrow$ **Create VPC**.
   - Select **VPC only**. Tag Name: `fanvault-vpc` | IPv4 CIDR block: `10.0.0.0/16`.
   - After creation, click **Actions** $\rightarrow$ **Edit VPC settings** $\rightarrow$ Check ✅ **Enable DNS hostnames** $\rightarrow$ **Save**.
2. **Create the Internet Gateway**:
   - Left sidebar $\rightarrow$ **Internet Gateways** $\rightarrow$ **Create internet gateway**. Name: `fanvault-igw`.
   - Select it $\rightarrow$ Click **Actions** $\rightarrow$ **Attach to VPC** $\rightarrow$ Select `fanvault-vpc`.
3. **Deploy the 6 Subnets**:
   Go to **Subnets** $\rightarrow$ **Create subnet** $\rightarrow$ Select `fanvault-vpc`. Add the subnets:
   - `fanvault-public-1a` | Availability Zone: `us-east-1a` | CIDR: `10.0.1.0/24`
   - `fanvault-public-1b` | Availability Zone: `us-east-1b` | CIDR: `10.0.2.0/24`
   - `fanvault-frontend-1a` | Availability Zone: `us-east-1a` | CIDR: `10.0.11.0/24`
   - `fanvault-frontend-1b` | Availability Zone: `us-east-1b` | CIDR: `10.0.12.0/24`
   - `fanvault-backend-1a` | Availability Zone: `us-east-1a` | CIDR: `10.0.21.0/24`
   - `fanvault-backend-1b` | Availability Zone: `us-east-1b` | CIDR: `10.0.22.0/24`
4. **Enable Auto-Assign Public IP on Public Subnets**:
   - Select `fanvault-public-1a` $\rightarrow$ **Actions** $\rightarrow$ **Edit subnet settings** $\rightarrow$ Check ✅ **Enable auto-assign public IPv4 address** $\rightarrow$ **Save**.
   - Repeat the same steps for `fanvault-public-1b`.
5. **Create the NAT Gateway**:
   - Left sidebar $\rightarrow$ **NAT Gateways** $\rightarrow$ **Create NAT gateway**.
   - Name: `fanvault-nat-gw` | Subnet: `fanvault-public-1a` | Connectivity type: Public.
   - Click **Allocate Elastic IP** $\rightarrow$ Click **Create NAT gateway**.
6. **Set up Route Tables**:
   - **Public Route Table (`fanvault-rt-public`)**: 
     * Create route table. Select VPC: `fanvault-vpc`.
     * Click **Routes** tab $\rightarrow$ **Edit routes** $\rightarrow$ **Add route**: Destination `0.0.0.0/0` $\rightarrow$ Target: **Internet Gateway** (`fanvault-igw`).
     * Click **Subnet associations** $\rightarrow$ **Edit** $\rightarrow$ Select `fanvault-public-1a` and `fanvault-public-1b` $\rightarrow$ **Save**.
   - **Private Route Table (`fanvault-rt-private`)**:
     * Create route table. Select VPC: `fanvault-vpc`.
     * Click **Routes** tab $\rightarrow$ **Edit routes** $\rightarrow$ **Add route**: Destination `0.0.0.0/0` $\rightarrow$ Target: **NAT Gateway** (`fanvault-nat-gw`).
     * Click **Subnet associations** $\rightarrow$ **Edit** $\rightarrow$ Select all 4 private subnets (`frontend-1a/1b` and `backend-1a/1b`) $\rightarrow$ **Save**.

---

### STEP 2: Deploy Networking (Part B: Mumbai Database VPC)
*Switch your AWS Management Console region to **`ap-south-1` (Mumbai)**.*

1. **Create the Database VPC**:
   - Go to **VPC Console** $\rightarrow$ **Create VPC** $\rightarrow$ **VPC only**.
   - Tag Name: `fanvault-db-vpc` | IPv4 CIDR block: `10.1.0.0/16`.
   - Select it $\rightarrow$ **Actions** $\rightarrow$ **Edit VPC settings** $\rightarrow$ Check ✅ **Enable DNS hostnames** $\rightarrow$ **Save**.
2. **Create the DB Private Subnet**:
   - Go to **Subnets** $\rightarrow$ **Create subnet** $\rightarrow$ Select `fanvault-db-vpc`.
   - Name: `fanvault-db-private-1a` | Availability Zone: `ap-south-1a` | CIDR: `10.1.31.0/24`.
3. **Create the DB Route Table**:
   - Go to **Route Tables** $\rightarrow$ **Create route table**. Tag Name: `fanvault-db-rt` | VPC: `fanvault-db-vpc`.
   - **Subnet associations** $\rightarrow$ **Edit** $\rightarrow$ Select `fanvault-db-private-1a` $\rightarrow$ **Save**. (Leave routes default local-only for now; no internet access allowed).

---

### STEP 3: Establish Inter-Region VPC Peering
*Switch your console region back to **`us-east-1` (N. Virginia)**.*

1. **Request the Peering Connection**:
   - VPC Console $\rightarrow$ **Peering connections** $\rightarrow$ **Create peering connection**.
   - Name: `fanvault-db-peering`.
   - **VPC ID (Requester)**: Select `fanvault-vpc` (`10.0.0.0/16`).
   - **Region**: Select **Another region** $\rightarrow$ **`ap-south-1`** (Mumbai).
   - **VPC ID (Accepter)**: Paste the VPC ID of `fanvault-db-vpc` (copy this from your Mumbai VPC console).
   - Click **Create peering connection**.
2. **Accept the Peering Connection (in Mumbai)**:
   - *Switch your console region to **`ap-south-1` (Mumbai)**.*
   - Go to **Peering connections** $\rightarrow$ Select the pending request `fanvault-db-peering`.
   - Click **Actions** $\rightarrow$ **Accept request** $\rightarrow$ Confirm.
3. **Configure Peering DNS Resolution**:
   - *With the peering connection selected in Mumbai*: Click **Actions** $\rightarrow$ **Edit DNS settings** $\rightarrow$ Check ✅ **DNS resolution from requester VPC** $\rightarrow$ **Save**.
   - *Switch to **`us-east-1` (N. Virginia)**:* Go to **Peering connections** $\rightarrow$ Select `fanvault-db-peering` $\rightarrow$ **Actions** $\rightarrow$ **Edit DNS settings** $\rightarrow$ Check ✅ **DNS resolution from accepter VPC** $\rightarrow$ **Save**.
4. **Update Route Tables with Peering Paths**:
   - **In N. Virginia (`us-east-1`)**:
     * VPC Console $\rightarrow$ **Route Tables** $\rightarrow$ Select `fanvault-rt-private`.
     * Click **Routes** $\rightarrow$ **Edit routes** $\rightarrow$ **Add route**: Destination `10.1.0.0/16` $\rightarrow$ Target: **Peering Connection** $\rightarrow$ Select `fanvault-db-peering`. Save.
   - **In Mumbai (`ap-south-1`)**:
     * VPC Console $\rightarrow$ **Route Tables** $\rightarrow$ Select `fanvault-db-rt`.
     * Click **Routes** $\rightarrow$ **Edit routes** $\rightarrow$ **Add route**: Destination `10.0.0.0/16` $\rightarrow$ Target: **Peering Connection** $\rightarrow$ Select `fanvault-db-peering`. Save.

---

### STEP 4: Configure Security Groups
1. **In `us-east-1` (N. Virginia)**:
   Go to **EC2 Console** $\rightarrow$ **Security Groups** $\rightarrow$ **Create security group**:
   - **`fanvault-alb-sg`**: Inbound allows HTTP (80) and HTTPS (443) from `0.0.0.0/0`.
   - **`fanvault-frontend-sg`**: Inbound allows HTTP (80) from Source: Custom $\rightarrow$ Select `fanvault-alb-sg`.
   - **`fanvault-backend-sg`**: Inbound allows Custom TCP (3001) and Custom TCP (3002) from Source: Custom $\rightarrow$ Select `fanvault-alb-sg`.
   - **`fanvault-bastion-sg`**: Inbound allows SSH (22) from Source: **My IP** (auto-fills your current IP).
   
   *Update private instance SSH rules*:
   - Edit inbound rules for `fanvault-frontend-sg` $\rightarrow$ Add: SSH (22) from `fanvault-bastion-sg`.
   - Edit inbound rules for `fanvault-backend-sg` $\rightarrow$ Add: SSH (22) from `fanvault-bastion-sg`.
2. **In `ap-south-1` (Mumbai)**:
   Go to **EC2 Console** $\rightarrow$ **Security Groups** $\rightarrow$ **Create security group**:
   - **`fanvault-db-sg`**:
     * Inbound Rule 1: Custom TCP (27017) from Source: `10.0.0.0/16` (Allows primary VPC apps).
     * Inbound Rule 2: SSH (22) from Source: `10.0.0.0/16` (Allows administration via N. Virginia Bastion).

---

### STEP 5: Deploy MongoDB (Mumbai)
*Make sure you are in the **`ap-south-1` (Mumbai)** region.*

1. **Launch the MongoDB EC2**:
   - Go to **EC2 Console** $\rightarrow$ **Launch instance**.
   - Name: `fanvault-mongodb` | AMI: **Ubuntu Server 22.04 LTS** | Instance Type: `t3.medium`.
   - Key pair: Create and download `fanvault-db-key.pem`.
   - **Network settings $\rightarrow$ Edit**:
     * VPC: `fanvault-db-vpc`
     * Subnet: `fanvault-db-private-1a`
     * Auto-assign public IP: **Disable**
     * Security Group: `fanvault-db-sg`
   - Storage: `50 GiB` / gp3. Launch instance.
   - Note the **Private IP address** from the console (e.g., `10.1.31.100`).

---

### STEP 6: Route53 Private DNS Setup
*Switch your console region back to **`us-east-1` (N. Virginia)**.*

1. **Create Private Hosted Zone**:
   - Go to **Route 53** $\rightarrow$ **Hosted zones** $\rightarrow$ **Create hosted zone**.
   - Domain name: `fanvault.internal` | Type: **Private hosted zone**.
   - Region: `us-east-1` | VPC ID: Select `fanvault-vpc`. Click **Create**.
2. **Map the Database DNS Record**:
   - Inside `fanvault.internal` PHZ $\rightarrow$ Click **Create record**.
   - Record name: `db` | Type: **A** | Value: Enter the MongoDB EC2 Private IP (e.g. `10.1.31.100`).
   - TTL: `60`. Click **Create records**.
3. **Associate the Private Hosted Zone with the Mumbai VPC**:
   *AWS Console does not allow cross-region Hosted Zone associations. Run this command from your local terminal with configured AWS CLI credentials:*
   ```bash
   aws route53 associate-vpc-with-hosted-zone \
     --hosted-zone-id YOUR_ZONE_ID_HERE \
     --vpc VPCRegion=ap-south-1,VPCId=YOUR_MUMBAI_VPC_ID_HERE
   ```

---

## 4. Application Server Deployment Walkthrough

Deploy the backend services and seed your data.

### STEP 1: Launch Application Instances (N. Virginia)
*Make sure you are in **`us-east-1`**.*

Launch three separate EC2 instances in your private subnets to serve as your **Golden Instances** (which we will configure and bake into AMIs later):
1. **`fanvault-identity-svc`** (Golden instance for Auth ASG):
   - Subnet: `fanvault-backend-1a` | Public IP: **Disable** | Security Group: `fanvault-backend-sg` | Type: `t3.small`
2. **`fanvault-commerce-svc`** (Golden instance for Commerce ASG):
   - Subnet: `fanvault-backend-1a` | Public IP: **Disable** | Security Group: `fanvault-backend-sg` | Type: `t3.small`
3. **`fanvault-frontend-svc`** (Golden instance for Nginx ASG):
   - Subnet: `fanvault-frontend-1a` | Public IP: **Disable** | Security Group: `fanvault-frontend-sg` | Type: `t3.small`
4. **`fanvault-bastion`** (Jump host in public subnet):
   - Subnet: `fanvault-public-1a` | Public IP: **Enable** | Security Group: `fanvault-bastion-sg` | Type: `t3.micro`

---

### STEP 2: Configure SSH Agent Forwarding
To connect securely to your private instances without exposing your private `.pem` key files on the public bastion host:

1. **On your local machine**:
   ```bash
   # Add your key to SSH agent
   ssh-add -K fanvault-key.pem
   
   # Jump into public Bastion host forwarding keys
   ssh -A ubuntu@YOUR_BASTION_PUBLIC_IP
   ```
2. **From the Bastion shell**, connect directly to the private nodes:
   ```bash
   ssh ubuntu@YOUR_IDENTITY_PRIVATE_IP
   ssh ubuntu@YOUR_COMMERCE_PRIVATE_IP
   ssh ubuntu@YOUR_FRONTEND_PRIVATE_IP
   ```

---

### STEP 3: MongoDB Native Setup (ap-south-1 Mumbai)
Connect to the MongoDB private node by jumping from your N. Virginia Bastion:
```bash
# From Bastion, connect to Mumbai DB Private IP
ssh ubuntu@10.1.31.100
```

1. **Install MongoDB 7.0**:
   ```bash
   curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
     gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
   
   echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] \
     https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
     sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
   
   sudo apt-get update && sudo apt-get install -y mongodb-org
   ```
2. **Enable Inbound Network Access & Security**:
   ```bash
   sudo nano /etc/mongod.conf
   ```
   Modify these sections:
   ```yaml
   net:
     port: 27017
     bindIp: 0.0.0.0       # Allow connections from peered VPC
   
   security:
     authorization: enabled # Enable RBAC authentication
   ```
   Save and restart:
   ```bash
   sudo systemctl enable mongod && sudo systemctl restart mongod
   ```
3. **Configure Database Users**:
   ```bash
   mongosh
   ```
   ```javascript
   use admin
   db.createUser({
     user: "dbadmin",
     pwd: "StrongAdminPassword123",
     roles: [ { role: "userAdminAnyDatabase", db: "admin" }, "readWriteAnyDatabase" ]
   })
   
   use fanvault_db
   db.createUser({
     user: "dbuser",
     pwd: "AppSecurePassword2026",
     roles: [ { role: "readWrite", db: "fanvault_db" } ]
   })
   exit
   ```

---

### STEP 4: Deploy Identity & Commerce Services (us-east-1)

Run this sequence on **both** the `fanvault-identity-svc` and `fanvault-commerce-svc` private EC2 instances:

1. **Install Node.js 18 & PM2/Systemd environment**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin fanvault
   ```
2. **Deploy Application Files**:
   *From your local machine, transfer directories to the private target nodes using SCP through the Bastion proxy:*
   ```bash
   scp -o "ProxyJump ubuntu@YOUR_BASTION_PUBLIC_IP" -r ./fanvault-user-auth-service ubuntu@YOUR_IDENTITY_PRIVATE_IP:/home/ubuntu/
   ```
3. **Configure the Environment variables (`.env`)**:
   Create `/var/www/fanvault-user-auth-service/.env` on the instance:
   ```bash
   PORT=3001
   NODE_ENV=production
   # Resolves cross-region via Route53 private DNS
   MONGO_URI=mongodb://dbuser:AppSecurePassword2026@db.fanvault.internal:27017/fanvault_db?authSource=fanvault_db
   JWT_SECRET=supersecretjwtsigningkeyhere123!
   CORS_ORIGIN=http://YOUR_ALB_DNS_NAME
   ```
   *(Ensure the Commerce service `.env` uses `PORT=3002`, the same `MONGO_URI`, and the exact same `JWT_SECRET` for stateless token verification).*
4. **Install Dependencies & Start systemd daemon**:
   ```bash
   cd /var/www/fanvault-user-auth-service
   sudo npm install --omit=dev
   sudo chown -R fanvault:fanvault /var/www/fanvault-user-auth-service
   
   # Copy systemd service file
   sudo cp /home/ubuntu/fanvault-user-auth-service/deploy/fanvault-auth.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable fanvault-auth
   sudo systemctl start fanvault-auth
   ```

---

### STEP 5: Run Database Seeder
Upload the seed script from your local machine to the private Identity instance:
```bash
scp -o "ProxyJump ubuntu@YOUR_BASTION_PUBLIC_IP" ./shared-resources/database/seed-data.js ubuntu@YOUR_IDENTITY_PRIVATE_IP:/home/ubuntu/
```
SSH into the Identity instance and execute:
```bash
cd /home/ubuntu
npm install mongoose bcryptjs dotenv
MONGO_URI="mongodb://dbuser:AppSecurePassword2026@db.fanvault.internal:27017/fanvault_db?authSource=fanvault_db" node seed-data.js
```

---

### STEP 6: Deploy Frontend (us-east-1)
1. **Compile React static assets locally**:
   ```bash
   cd fanvault-frontend
   npm install && npm run build # Outputs compiled assets to dist/
   ```
2. **Upload assets to the Frontend EC2 instance**:
   ```bash
   scp -o "ProxyJump ubuntu@YOUR_BASTION_PUBLIC_IP" -r ./dist ubuntu@YOUR_FRONTEND_PRIVATE_IP:/home/ubuntu/
   ```
3. **Install and configure Nginx on the Frontend node**:
   ```bash
   sudo apt-get update && sudo apt-get install -y nginx
   sudo mkdir -p /var/www/fanvault-frontend
   sudo rsync -av /home/ubuntu/dist/ /var/www/fanvault-frontend/dist/
   ```
   Configure Nginx server block (`/etc/nginx/sites-available/default`):
   ```nginx
   server {
       listen 80;
       server_name _;
       root /var/www/fanvault-frontend/dist;
       index index.html;

       location / {
           try_files $uri $uri/ /index.html;
       }
   }
   ```
   Verify configurations and restart Nginx:
   ```bash
   sudo nginx -t && sudo systemctl enable nginx && sudo systemctl restart nginx
   ```

---

## 5. Load Balancing & Auto Scaling Setup

Now we will scale our single-instance deployment into a high-availability, auto-scaling multi-AZ structure.

### STEP 1: Bake Golden AMIs
On the AWS EC2 Console, stop your validated golden instances (`fanvault-identity-svc`, `fanvault-commerce-svc`, `fanvault-frontend-svc`). 
- Right-click each instance $\rightarrow$ **Image and templates** $\rightarrow$ **Create image**.
- Tags: `fanvault-identity-ami-v2`, `fanvault-commerce-ami-v2`, `fanvault-frontend-ami-v2`.

---

### STEP 2: Create Target Groups
Create three target groups in **`us-east-1`** under **EC2 Console** $\rightarrow$ **Target groups**:
1. **`fanvault-frontend-tg`**: Protocol: `HTTP` | Port: `80` | VPC: `fanvault-vpc` | Health Check Path: `/index.html`.
2. **`fanvault-identity-tg`**: Protocol: `HTTP` | Port: `3001` | VPC: `fanvault-vpc` | Health Check Path: `/health`.
3. **`fanvault-commerce-tg`**: Protocol: `HTTP` | Port: `3002` | VPC: `fanvault-vpc` | Health Check Path: `/health`.

---

### STEP 3: Setup the Application Load Balancer
1. Go to **Load Balancers** $\rightarrow$ **Create Load Balancer** $\rightarrow$ **Application Load Balancer**.
2. Name: `fanvault-alb` | Scheme: Internet-facing | Address: IPv4 | VPC: `fanvault-vpc`.
3. **Mappings**: Select both Availability Zones `us-east-1a` and `us-east-1b`, linking them to the **Public Subnets** (`fanvault-public-1a` and `fanvault-public-1b`).
4. Select Security Group: `fanvault-alb-sg`.
5. **Listeners & Routing**:
   - Listener 1: HTTPS (Port 443) $\rightarrow$ Default Action: Forward to `fanvault-frontend-tg` $\rightarrow$ Select ACM wild-card certificate.
   - Listener 2: HTTP (Port 80) $\rightarrow$ Default Action: **Redirect to HTTPS** (301 Permanent Redirect).
6. **Configure HTTPS Listener Rules (evaluated top-to-bottom)**:
   - **Rule 1 (P10)**: Path is `/api/auth/*` $\rightarrow$ Forward to `fanvault-identity-tg`.
   - **Rule 2 (P20)**: Path is `/api/users/*` $\rightarrow$ Forward to `fanvault-identity-tg`.
   - **Rule 3 (P30)**: Path is `/api/products/*` $\rightarrow$ Forward to `fanvault-commerce-tg`.
   - **Rule 4 (P40)**: Path is `/api/orders/*` $\rightarrow$ Forward to `fanvault-commerce-tg`.
   - **Rule 5 (P99, Default)**: Path is `/*` $\rightarrow$ Forward to `fanvault-frontend-tg`.

---

### STEP 4: Deploy Auto Scaling Groups (ASG)
For each service (Frontend, Identity, Commerce), create a **Launch Template** and an **Auto Scaling Group**:

1. **Create Launch Templates**:
   - Source AMI: Use your corresponding baked AMI (e.g. `fanvault-identity-ami-v2`).
   - Instance Type: `t3.small` | Key Pair: `fanvault-key` | Security Group: corresponding SG (e.g., `fanvault-backend-sg`).
2. **Create Auto Scaling Groups**:
   - Link the corresponding Launch Template.
   - **Network Mappings**: VPC: `fanvault-vpc` | Subnets: Private subnets `1a` and `1b` (e.g. `fanvault-backend-1a` and `fanvault-backend-1b` for backend ASGs).
   - **Load Balancing**: Integrate with existing load balancer $\rightarrow$ Select target group (e.g. `fanvault-identity-tg`).
   - **Group size**: Desired Capacity: `2` | Minimum Capacity: `2` | Maximum Capacity: `4`.
   - **Scaling Policies**: Select **Target Tracking** $\rightarrow$ Metric type: Average CPU utilization $\rightarrow$ Target value: `70` | Cooldown: `300 seconds`.

---

## 6. S3 & Lambda Host-Based Routing Integration

Demonstrate secure serverless hosting using host-based ALB routing:

1. **Deploy S3 Private Bucket**:
   - Go to **S3 Console** $\rightarrow$ **Create bucket**. Name: `fanvault-architecture-bucket` (block all public access).
   - Upload your static architecture page `architecture.html` or diagram image `architecture.png`.
2. **Create IAM Role for Lambda**:
   - Go to **IAM Console** $\rightarrow$ **Roles** $\rightarrow$ **Create role** $\rightarrow$ Select **Lambda** service.
   - Attach policy: **`AmazonS3ReadOnlyAccess`** $\rightarrow$ Name: `fanvault-lambda-s3-role`.
3. **Provision the Lambda Function**:
   - Go to **Lambda Console** $\rightarrow$ **Create function**.
   - Name: `arch-page-lambda` | Runtime: Node.js 20.x | Role: `fanvault-lambda-s3-role`.
   - Paste the handler code (returns S3 content dynamically, with base64 conversion for binary assets):
     ```javascript
     const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
     const s3 = new S3Client({});

     exports.handler = async (event) => {
         try {
             const command = new GetObjectCommand({
                 Bucket: "fanvault-architecture-bucket",
                 Key: "architecture.png" // or architecture.html
             });
             const response = await s3.send(command);
             const body = await response.Body.transformToByteArray();
             const base64String = Buffer.from(body).toString("base64");

             return {
                 statusCode: 200,
                 statusDescription: "200 OK",
                 isBase64Encoded: true,
                 headers: {
                     "Content-Type": "image/png",
                     "Cache-Control": "public, max-age=86400"
                 },
                 body: base64String
             };
         } catch (err) {
             return {
                 statusCode: 500,
                 headers: { "Content-Type": "text/plain" },
                 body: "Internal Server Error: " + err.message
             };
         }
     };
     ```
   - Click **Deploy**.
4. **Connect Lambda to the ALB**:
   - Go to **Target Groups** $\rightarrow$ **Create target group**. Target type: **Lambda function** | Name: `fanvault-lambda-tg`. Register `arch-page-lambda`.
   - Go to **Load Balancer (`fanvault-alb`)** $\rightarrow$ HTTPS Listener Rules $\rightarrow$ **Add rule (Priority 5)**:
     * Condition: **Host Header** is `arch.fanvault.com`
     * Action: Forward to `fanvault-lambda-tg`.

---

## 7. Verification and Troubleshooting

### End-to-End Verification Checklists

#### 1. Confirm Cross-Region Port Connectivity (Mumbai $\leftrightarrow$ N. Virginia)
SSH into any backend instance in N. Virginia (`us-east-1`) and verify:
```bash
# 1. Verify Private Route53 resolves to Mumbai Private IP
nslookup db.fanvault.internal
# Expected output: Address: 10.1.31.100

# 2. Test TCP transit over the Peering link
nc -zv db.fanvault.internal 27017
# Expected output: Connection to db.fanvault.internal port 27017 [tcp/*] succeeded!
```

#### 2. Confirm App Health Checks & DB Access
```bash
# Health check endpoints should return DB connected status
curl http://localhost:3001/health
# Expected: {"status":"ok","db":"connected"}

curl http://localhost:3002/health
# Expected: {"status":"ok","db":"connected"}
```

### Common Issues & Resolving Patches

| Sympton / Error | Cause | Quick Fix |
|---|---|---|
| MongoDB connection times out | Missing peering connection routes | Ensure N. Virginia private route tables have `10.1.0.0/16` pointing to `pcx`, and Mumbai route tables have `10.0.0.0/16` pointing to `pcx`. |
| `mongosh` connection rejected | IP Bindings incorrect in config | Edit `/etc/mongod.conf` in Mumbai, set `bindIp: 0.0.0.0`, and restart service. |
| Authentication fails on connection | Missing authSource in connection URI | Ensure Node.js connection URI explicitly includes `?authSource=fanvault_db` parameter. |
| Lambda images render as broken text | missing base64 settings | Ensure the Lambda ALB integration response has `isBase64Encoded: true` and the binary buffer is parsed as base64. |

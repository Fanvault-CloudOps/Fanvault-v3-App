# FanVault v2 — Comprehensive Technical Preparation Guide

Welcome to the ultimate technical preparation document for **FanVault v2**. This guide is designed to prepare you to defend your capstone architecture in front of an enterprise technical review panel, viva examiners, or cloud engineering interviewers. It progresses from high-level summaries to deep-dive networking, infrastructure design, security matrices, database patterns, and scenario-based troubleshooting.

---

## 1. Project Overview

### What the Project Does
**FanVault v2** is a production-grade, highly available, secure, and auto-scaling full-stack e-commerce application designed for fan merchandise. 

The original codebase (FanVault v1) was built as a fragmented set of **6 tightly-coupled microservices** (frontend, authentication, users, products, orders, and emails). In production, this created significant inter-service network latency, complex deployment orchestration, and high operational costs.

For **FanVault v2**, the architecture was optimized and consolidated into **3 robust, independently deployable services** running on AWS:
1. **`fanvault-frontend`**: A static React/Vite Single Page Application (SPA) compiled and hosted on lightweight, high-performance Nginx servers serving content over port 80.
2. **`fanvault-user-auth-service` (Identity Service)**: A Node.js/Express service running on port 3001. It consolidates user authentication, JWT issuance, profile management, and shipping addresses, eliminating frequent inter-service REST calls.
3. **`fanvault-commerce-service` (Commerce Service)**: A Node.js/Express service running on port 3002. It combines the product catalog, order checkout, inventory management, and cart operations. The legacy email service was decommissioned and replaced by asynchronous structured logging events (`console.log`) to save computational overhead.

### High-Level Architecture
The system is divided into two separate, secure AWS regions:
- **Primary Application VPC (`10.0.0.0/16`) in `ap-south-1` (Mumbai)**: Hosts the public Application Load Balancer, the three Auto Scaling Groups (ASGs) across multiple Availability Zones, the secure NAT Gateway, S3/Lambda integrations, and the Bastion Host.
- **Database VPC (`10.1.0.0/16`) in `ap-southeast-1` (Singapore)**: Hosts the production MongoDB instance. This VPC is completely private, has no Internet Gateway, and connects to the Primary VPC using **Inter-Region VPC Peering** (`pcx-xxxxx`).

```
[User Browser] --(HTTPS:443 / CNAME: fanvault.com)--> [Application Load Balancer (ALB)]
                                                            │
                 ┌──────────────────────────────────────────┼──────────────────────────────────────────┐
                 │ (Priority 5: arch.fanvault.com)          │ (Priority 99: Default /*)                │ (Priority 10-40: /api/*)
                 ▼                                          ▼                                          ▼
      [arch-page-lambda Target Group]            [fanvault-frontend-tg]                     [Backend App Target Groups]
                 │                                          │                                          │
                 ▼ (S3 Read IAM Role)                       ▼ (Private Subnets 1a/1b)                  ▼ (Private Subnets 1a/1b)
      [Lambda: Node.js 20.x]                     [Nginx Auto Scaling Group]                [Express API Auto Scaling Groups]
                 │                                   (React Static SPA)                       (Identity :3001 / Commerce :3002)
                 ▼                                                                                     │
         [S3 Private Bucket]                                                                           ▼ (Private Route53 / Peering)
      (architecture.html / .png)                                                             db.fanvault.internal
                                                                                                       │
                                                                                                       ▼ (VPC Peering: pcx-xxxxx)
                                                                                            [MongoDB EC2 (Singapore)]
                                                                                              (t3.medium / Port 27017)
```

### End-to-End Request Flow
1. **Client Connection**: The user inputs `https://fanvault.com` in their browser. Route53 resolves the domain to the **Application Load Balancer (ALB)** alias record.
2. **TLS Termination**: The ALB terminates the HTTPS session at the edge using an **AWS Certificate Manager (ACM)** wild-card certificate (`*.fanvault.com`). The ALB processes the request and maps it to target groups.
3. **Routing Evaluation**: The ALB evaluates routing rules in strict priority sequence:
   - **Host: `arch.fanvault.com`** (Priority 5) $\rightarrow$ Routes to `arch-page-lambda` target group. The Lambda fetches `architecture.png` or `architecture.html` from a private S3 bucket and returns it.
   - **Path: `/api/auth/*` or `/api/users/*`** (Priority 10 & 20) $\rightarrow$ Routes directly to the **Identity Service Target Group** (private EC2 instances, port 3001).
   - **Path: `/api/products/*` or `/api/orders/*`** (Priority 30 & 40) $\rightarrow$ Routes directly to the **Commerce Service Target Group** (private EC2 instances, port 3002).
   - **Path: `/*`** (Priority 99, Default) $\rightarrow$ Routes to the **Frontend Service Target Group** (private Nginx instances, port 80) serving static React/Vite assets.
4. **Database Query**: When the Identity or Commerce services query the database, they connect to `db.fanvault.internal:27017`.
5. **Cross-Region DNS Resolution**: The Route53 Private Hosted Zone resolves `db.fanvault.internal` to the private IP `10.1.31.100` (residing in the `ap-southeast-1` Singapore VPC).
6. **VPC Peering Transit**: The traffic travels securely over the **AWS Private Backbone Network** using Inter-Region VPC Peering (`pcx-xxxxx`).
7. **Database Authentication**: The MongoDB instance, bound to `0.0.0.0` but isolated in a private security group (`fanvault-db-sg`), verifies credentials against the local `fanvault_db` database using the `authSource=fanvault_db` mechanism, returning the requested data.

---

## 2. Complete AWS Architecture Explanation

### Virtual Private Cloud (VPC)
- **Primary VPC (`10.0.0.0/16`)**: Set up in Mumbai (`ap-south-1`). This network segments public ingress (ALB), internal application services (ASGs), and egress routing (NAT).
- **Database VPC (`10.1.0.0/16`)**: Set up in Singapore (`ap-southeast-1`). It is a database enclave containing only a private database subnet with no ingress path from the public internet.

### Subnets
Subnet segmentation enforces physical layer isolation within the primary VPC:
- **Public Subnets (`10.0.1.0/24`, `10.0.2.0/24`)**: Spans `ap-south-1a` and `ap-south-1b`. Host the internet-facing ALB, NAT Gateway, and Bastion Host. Auto-assign public IP is enabled only here.
- **Frontend Private Subnets (`10.0.11.0/24`, `10.0.12.0/24`)**: Spans `ap-south-1a` and `ap-south-1b`. Contains the Nginx ASG. They have NO public IPs and communicate only with the NAT Gateway for outbound traffic and the ALB for inbound port 80 traffic.
- **Backend Private Subnets (`10.0.21.0/24`, `10.0.22.0/24`)**: Spans `ap-south-1a` and `ap-south-1b`. Contains the Identity and Commerce Node.js services.
- **Database Private Subnet (`10.1.31.0/24`)**: Located in `ap-southeast-1a`. Dedicated entirely to hosting the MongoDB instance.

### Route Tables
- **`fanvault-rt-public`**: Associated with public subnets. Contains a default route `0.0.0.0/0` targeting the **Internet Gateway** (`igw-xxxx`).
- **`fanvault-rt-private`**: Associated with Frontend and Backend private subnets. Contains:
  - Default route `0.0.0.0/0` targeting the **NAT Gateway** (`nat-xxxx`) for package downloads and external API access.
  - Peering route `10.1.0.0/16` targeting the **VPC Peering Connection** (`pcx-xxxx`) to forward database traffic to Singapore.
- **`fanvault-db-rt`**: Associated with the DB subnet in Singapore. Contains a peering route `10.0.0.0/16` targeting `pcx-xxxx` to return queries back to the Mumbai application servers. No internet route exists.

### Internet Gateway (IGW) & NAT Gateway
- **Internet Gateway**: Attached to `fanvault-vpc` to provide bi-directional internet access for the public subnets.
- **NAT Gateway**: Placed in public subnet `fanvault-public-1a` with an allocated Elastic IP. Translates private IP headers of EC2 instances to its public IP, allowing backend servers to download npm packages securely.

### Security Groups (Source-Group Chaining)
Rather than raw IP-based CIDR rules, security is enforced using strict logical dependency chains:
1. **`fanvault-alb-sg`**: Allows `TCP 80` and `443` from `0.0.0.0/0` (internet-facing).
2. **`fanvault-frontend-sg`**: Allows `TCP 80` exclusively from `fanvault-alb-sg`.
3. **`fanvault-backend-sg`**: Allows `TCP 3001` and `3002` exclusively from `fanvault-alb-sg`.
4. **`fanvault-db-sg`**: Located in Singapore. Allows `TCP 27017` exclusively from `10.0.0.0/16` (the peered primary VPC network range) and `TCP 22` from the administration bastion or connect endpoint.
5. **`fanvault-bastion-sg`**: Allows `TCP 22` exclusively from the administrator's specific home/office public IP.

### Network Access Control Lists (NACL)
- Default VPC NACLs are used in a stateless configuration allowing standard inbound/outbound transit. Security is heavily controlled at the stateful **Security Group** layer, which tracks connection states and automatically allows return traffic.

### Load Balancer (ALB)
- A cross-zone, internet-facing **Application Load Balancer** terminating SSL connections via ACM and applying host-based and path-based listener rules.

### EC2 / Launch Templates / ASG
- **Bastion Host (`t3.micro`)**: Exists in the public subnet for secure SSH administration.
- **MongoDB Server (`t3.medium`)**: Provisioned with a dedicated system instance to manage memory buffers for query execution.
- **Application Servers (`t3.small`)**: Organized into 3 distinct Auto Scaling Groups (Desired=2, Min=2, Max=4) with CPU-based scaling policies.

### IAM (Identity and Access Management)
- **`arch-page-lambda-role`**: An IAM service role attached to the Lambda function containing the AWS-managed policy `AmazonS3ReadOnlyAccess` allowing it to securely call `s3:GetObject` on the private S3 bucket without embedding access keys in the code.

### CloudWatch
- Gathers native metric data from the ALB, Auto Scaling groups (CPU utilization), and standard `syslog` output from Lambda.

### Storage & Databases
- **EBS (Elastic Block Store)**: `gp3` volumes are configured for all instances (50GB for DB, 20GB for apps). `gp3` is chosen for its price-performance ratio, offering 3,000 baseline IOPS regardless of volume size.
- **S3 (Simple Storage Service)**: Private bucket with disabled public access block. Stores the architecture diagram asset securely.
- **MongoDB**: 7.x Community edition installed natively on Ubuntu.

### DNS (Route53)
- **Public DNS**: DNS records map `fanvault.com` and `arch.fanvault.com` to the ALB's canonical DNS address.
- **Route53 Private Hosted Zone (`fanvault.internal`)**: Associated with both Mumbai and Singapore VPCs. Resolves `db.fanvault.internal` directly to `10.1.31.100` across the peering connection.

---

## 3. Why Each Service Was Used

The architectural decisions are based on the **AWS Well-Architected Framework**. The table below documents the engineering tradeoffs:

| AWS Service | Core Purpose in FanVault | Why Chosen | Alternatives Considered | Tradeoffs & Limitations |
|---|---|---|---|---|
| **EC2 (Instances)** | Compute hosting for monolithic backend and Nginx servers. | Strict project course requirement constraint to demonstrate bare-metal VM deployment and standard systemd process control. | **ECS Fargate / EKS (Containers)** | *Tradeoff*: High operational overhead. Requires manual patching, AMI updates, and systemd scripting compared to serverless containers. |
| **Application Load Balancer** | Layer 7 routing (Path & Host Rules) and SSL termination. | Supports advanced URI routing to direct `/api/auth/*` and `/api/products/*` straight to dedicated microservice backend targets. | **API Gateway / Network Load Balancer** | *Tradeoff*: API Gateway is easier to scale, but ALB provides direct VPC pathing, integration with EC2 target groups, and lower execution latency. |
| **AWS Lambda** | Serves static architectural review page/PNG from S3 on demand. | Near-zero cost. Prevents having to run and pay for a separate 24/7 EC2 instance just to render one architectural page. | **Dedicated EC2 Web Server** | *Tradeoff*: Introduces ~150-400ms cold start latency on first activation. Warm execution latency is negligible. |
| **Amazon S3** | Durable storage for architectural assets. | High durability (99.999999999%), cheap storage pricing, and secure policy binding. | **EBS Share / EFS** | *Tradeoff*: File retrieval is object-based via API (requires Lambda code proxy) rather than standard block storage mapping. |
| **Route53 (PHZ)** | Resolves private DNS `db.fanvault.internal` across regions. | Native DNS resolution that bridges seamlessly across peered VPC boundaries. | **Self-hosted BIND DNS** | *Tradeoff*: Extremely low cost ($0.50/month), but requires CLI commands to associate hosted zones with VPCs in other regions. |
| **NAT Gateway** | Translates private outbound traffic headers to public IP. | AWS-managed, highly available NAT service that scales automatically to support high packet transit. | **Self-hosted NAT Instance** | *Tradeoff*: Managed NAT costs ~$32/month base charge. A NAT instance is cheaper but represents a single point of failure (SPOF). |
| **VPC Peering** | Encrypted private transit between Mumbai and Singapore. | Low-latency private connection using the AWS backbone, bypassing the public internet entirely. | **AWS Transit Gateway / VPN** | *Tradeoff*: Peering is cheap and easy to set up, but it is strictly non-transitive (VPC A $\rightarrow$ B $\rightarrow$ C does not connect A to C). |

---

## 4. Networking Deep Dive

### CIDR Design
VPC Peering requires completely non-overlapping IP address ranges:
- **Mumbai Primary VPC**: `10.0.0.0/16` (Host IP range: `10.0.0.1` to `10.0.255.254`)
- **Singapore DB VPC**: `10.1.0.0/16` (Host IP range: `10.1.0.1` to `10.1.255.254`)

### Public vs. Private Subnet Division
- **Public Subnet (`10.0.1.0/24`)**: Configured with a route `0.0.0.0/0` pointing directly to the **Internet Gateway**. Instances launched here must have public IPs allocated.
- **Private Subnets (`10.0.11.0/24`, `10.0.21.0/24`, `10.1.31.0/24`)**: Configured with a route `0.0.0.0/0` pointing to the **NAT Gateway** (or no route to internet at all for the DB VPC). Inbound connections from the outside internet are physically blocked at the router layer.

### Stateful Security Group Filtering
Because Security Groups are stateful, when an application instance in Mumbai initiates a database query to `10.1.31.100` on port `27017`:
1. The outbound filter in Mumbai checks if port `27017` is permitted outbound.
2. The packet travels over the peered link.
3. The inbound filter on the MongoDB security group checks if the source matches `10.0.0.0/16`. It is allowed in.
4. The database responds. The security group automatically remembers the established socket state and allows the response back to Mumbai without requiring an explicit inbound rule on the application security group.

### NAT Translation Flow
```
[Private App EC2: 10.0.21.45] ──(HTTP GET: npm install)──► [NAT Gateway: 10.0.1.89 (Public Subnet)]
                                                                    │
                                                  (Rewrites Source IP Header to Public IP: 13.56.78.90)
                                                                    │
                                                                    ▼
[NPM Registry (Public)] ◄────────────────────────────────(Public Internet Transit)
```

---

## 5. Terraform Deep Dive

Although the infrastructure was provisioned via the AWS Management Console, an enterprise review panel will expect you to understand how to model this entire setup using **Terraform (Infrastructure as Code)**.

### Directory Structure & Modules
To keep the codebase clean, modular, and maintainable, the infrastructure should be divided into reusable modules:
```
├── main.tf                 # Root configuration invoking modules
├── variables.tf            # Root variables
├── outputs.tf              # Root outputs
├── providers.tf            # AWS Provider config (Mumbai + Singapore)
└── modules/
    ├── vpc/                # Multi-region VPC creation, subnets, route tables
    ├── security/           # Source-chained Security Groups
    ├── compute/            # Launch templates, EC2s, Bastion, IAM policies
    ├── load_balancer/      # ALB, Target Groups, CNAME validation
    └── database/           # Cross-region MongoDB provisioning
```

### Multi-Provider Configuration (Cross-Region)
To provision resources in both Mumbai and Singapore, you must define alias providers in `providers.tf`:
```hcl
provider "aws" {
  region = "ap-south-1" # Primary Region
}

provider "aws" {
  alias  = "singapore"
  region = "ap-southeast-1" # DB Region
}
```

### Resource Declarations for Peering & DNS
Here is the production-grade Terraform code used to establish the Inter-Region Peering and Route53 Private Hosted Zone associations:

```hcl
# 1. Requester side of VPC Peering (Mumbai)
resource "aws_vpc_peering_connection" "primary_to_db" {
  vpc_id        = var.primary_vpc_id
  peer_vpc_id   = var.db_vpc_id
  peer_region   = "ap-southeast-1"
  auto_accept   = false

  tags = {
    Name = "fanvault-db-peering"
  }
}

# 2. Accepter side of VPC Peering (Singapore)
resource "aws_vpc_peering_connection_accepter" "db_accepter" {
  provider                  = aws.singapore
  vpc_peering_connection_id = aws_vpc_peering_connection.primary_to_db.id
  auto_accept               = true

  tags = {
    Name = "fanvault-db-peering-accepter"
  }
}

# 3. Enable DNS resolution across VPC Peering
resource "aws_vpc_peering_connection_options" "requester_dns" {
  vpc_peering_connection_id = aws_vpc_peering_connection.primary_to_db.id

  requester {
    allow_remote_vpc_dns_resolution = true
  }
}

resource "aws_vpc_peering_connection_options" "accepter_dns" {
  provider                  = aws.singapore
  vpc_peering_connection_id = aws_vpc_peering_connection.primary_to_db.id

  accepter {
    allow_remote_vpc_dns_resolution = true
  }
}

# 4. Route53 Private Hosted Zone in Mumbai
resource "aws_route53_zone" "private" {
  name = "fanvault.internal"

  vpc {
    vpc_id     = var.primary_vpc_id
    vpc_region = "ap-south-1"
  }
}

# 5. Cross-Region Hosted Zone Association (Singapore DB VPC)
resource "aws_route53_zone_association" "db_vpc_association" {
  provider   = aws.singapore
  zone_id    = aws_route53_zone.private.zone_id
  vpc_id     = var.db_vpc_id
  vpc_region = "ap-southeast-1"
}
```

### Dynamic Blocks and `for_each` Loop Logic
To avoid repeating security group rules, use `dynamic` blocks inside the Security Group resource:
```hcl
variable "backend_ingress_rules" {
  type = list(object({
    port        = number
    description = string
  }))
  default = [
    { port = 3001, description = "Allow Identity Service Port" },
    { port = 3002, description = "Allow Commerce Service Port" }
  ]
}

resource "aws_security_group" "backend_sg" {
  name        = "fanvault-backend-sg"
  vpc_id      = var.primary_vpc_id

  dynamic "ingress" {
    for_each = var.backend_ingress_rules
    content {
      description     = ingress.value.description
      from_port       = ingress.value.port
      to_port         = ingress.value.port
      protocol        = "tcp"
      security_groups = [var.alb_sg_id] # Source Group Chaining
    }
  }
}
```

### State Management & Locking
- **Local vs. Remote State**: Production Terraform uses a **Remote S3 Backend** instead of storing the state file locally on your machine. This prevents developers from accidentally overwriting changes.
- **State Locking**: A **DynamoDB Table** is configured alongside S3. When a developer runs `terraform apply`, Terraform locks the state using a DynamoDB key. If another developer attempts to run `apply` at the exact same time, the execution is blocked until the lock is released.

---

## 6. Deployment Flow

### Infrastructure Provisioning Order
To satisfy resource dependency mappings, infrastructure must be built in this exact order:
1. **Network Layer**: Create Primary and DB VPCs $\rightarrow$ Deploy subnets $\rightarrow$ Attach IGWs/NATs $\rightarrow$ Establish Peering (`pcx`) $\rightarrow$ Create Route Tables and link the Peering routes.
2. **DNS & Security Layer**: Provision Route53 Private Hosted Zone $\rightarrow$ Associate with both VPCs $\rightarrow$ Deploy Security Groups.
3. **Database Server**: Launch MongoDB EC2 in Singapore $\rightarrow$ Install database engine $\rightarrow$ Update private A Record (`db.fanvault.internal`).
4. **App Servers & Bastion**: Launch Bastion Host in Mumbai $\rightarrow$ Launch App Golden Instances (Identity, Commerce, Frontend) in Mumbai private subnets.
5. **Load Balancer (ALB)**: Create ACM wild-card certificates $\rightarrow$ Provision target groups and ALB listeners.

### Application Deployment & systemd Configuration
When deploying the Node.js apps manually, you run them inside **systemd service units** to ensure they restart automatically if they crash:

```ini
# Example path: /etc/systemd/system/fanvault-auth.service
[Unit]
Description=FanVault Identity Service Node Backend
After=network.target

[Service]
Type=simple
User=fanvault
WorkingDirectory=/var/www/fanvault-user-auth-service
EnvironmentFile=/var/www/fanvault-user-auth-service/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=fanvault-auth

[Install]
WantedBy=multi-user.target
```

**Baking AMIs and Refreshing Auto Scaling Groups:**
1. Log into your golden EC2 instances $\rightarrow$ Pull code $\rightarrow$ Run `npm install` $\rightarrow$ Write environmental `.env` files.
2. Enable the services: `sudo systemctl enable fanvault-auth` (This is critical: it configures systemd to start the server automatically upon instance boot).
3. From the AWS console, shut down the instances temporarily and select **Create Image (AMI)**.
4. Update the **AWS Launch Templates** to reference the new AMI versions.
5. Trigger an **ASG Instance Refresh** with a `50% minimum healthy percentage`. The ASG will spin up new EC2s using the new AMI, confirm their health check via the ALB, and tear down the old instances with zero application downtime.

---

## 7. Application Flow

### Request Lifecycle
```
[Client SPA React App]
        │
    (1) relative GET /api/products
        │
        ▼
[Application Load Balancer] (Terminates TLS, examines path rules)
        │
    (2) forwards request to Node.js port 3002
        │
        ▼
[Commerce EC2 (Mumbai Private Subnet)] (Translates request, queries database)
        │
    (3) queries db.fanvault.internal (port 27017)
        │
        ▼ (Resolved to 10.1.31.100 by Route53, routed over Peering Connection)
[MongoDB Server (Singapore Private Subnet)]
```

### Shared Stateless JWT Authentication Flow
Rather than maintaining active user sessions in memory or in a shared database cache, the backend implements **stateless JSON Web Token (JWT)** validation:
1. The user logs in via the Frontend SPA, sending credentials to `/api/auth/login`.
2. The ALB routes the request to the **Identity Service ASG**. The service validates the credentials against MongoDB and signs a JWT containing the user's ID, role, and email using a highly secure private variable `JWT_SECRET`.
3. The JWT is returned to the client and stored in the browser's `localStorage` or a secure cookie.
4. When the user navigates to the checkout page and triggers a request to `/api/orders` (which is routed to the **Commerce Service ASG**):
   - The Commerce service extracts the JWT from the `Authorization: Bearer <token>` HTTP header.
   - Because the Commerce service shares the exact same `JWT_SECRET` in its `.env` file, it can validate the token's cryptographic signature locally without making a network call to the Identity service.
   - This architectural decision decouples the services, removes inter-service network dependency, and improves API response times.

---

## 8. Security Deep Dive

### Security Group Inbound/Outbound Rules Matrix
This is the complete source-group chaining matrix used in production.

| Security Group Name | Inbound Allowed Port/Protocol | Allowed Source | Outbound Allowed Port/Protocol | Allowed Destination | Architectural Rationale |
|---|---|---|---|---|---|
| **`fanvault-alb-sg`** | `TCP 80` (HTTP)<br>`TCP 443` (HTTPS) | `0.0.0.0/0` (Anywhere) | `TCP 80`<br>`TCP 3001` / `3002` | `fanvault-frontend-sg`<br>`fanvault-backend-sg` | Public access edge entry point. Terminates SSL and forwards clean HTTP backend traffic internally. |
| **`fanvault-frontend-sg`** | `TCP 80` | `fanvault-alb-sg` | `TCP 80`<br>`TCP 443` | `0.0.0.0/0` (via NAT Gateway) | Nginx servers hosting compiled React/Vite assets. Accepts connections exclusively from the ALB. |
| **`fanvault-backend-sg`** | `TCP 3001` (Identity)<br>`TCP 3002` (Commerce) | `fanvault-alb-sg` | `TCP 27017` (MongoDB) | `10.1.0.0/16` (Singapore VPC) | Node.js Express application servers. Accepts API traffic exclusively from the ALB and routes queries to MongoDB. |
| **`fanvault-db-sg`** | `TCP 27017` (MongoDB)<br>`TCP 22` (SSH) | `10.0.0.0/16` (Mumbai Primary CIDR)<br>`fanvault-bastion-sg` | None | None | MongoDB isolated database instance. Completely private; only accepts database calls from peered VPC app networks. |
| **`fanvault-bastion-sg`** | `TCP 22` | *Your specific admin home IP* | `TCP 22` | `fanvault-frontend-sg`<br>`fanvault-backend-sg`<br>`fanvault-db-sg` | Administrative access gateway. Restricted only to the administrator's public IP. |

### Secrets Management Strategy
- **EC2 Level**: Secrets (`JWT_SECRET`, database passwords, connection URIs) are loaded into systemd environment files on the instances. They are never committed to git repositories or hardcoded in the codebase.
- **Production Improvement**: The next architectural step is to migrate secrets to **AWS Secrets Manager**. Application servers can then fetch credentials dynamically using IAM roles at startup, eliminating the need to store static files on disk.

---

## 9. Scalability & High Availability

### Multi-AZ Availability Zone Partitioning
To protect against an entire data center going offline (e.g., power failures, optical line cuts), all application layers are deployed in a **Multi-AZ configuration**:
- The public ALB balances traffic across `ap-south-1a` and `ap-south-1b`.
- The three Auto Scaling Groups (Frontend, Identity, Commerce) are configured to launch instances evenly across both availability zones. If AZ `1a` fails, the ALB immediately stops routing traffic to unhealthy targets in `1a` and handles all requests using instances running in `1b`.

### Target Tracking Scaling Policies
Auto Scaling Groups scale out dynamically based on load:
- **Scaling Metric**: Average CPU Utilization.
- **Threshold**: `70%`.
- **Cooldown Period**: `300 seconds`.
- **How it works**: If an unexpected traffic spike occurs, average CPU across the ASG will rise. The Auto Scaling policy registers this metric and launches additional EC2 instances. These instances register automatically with their respective ALB target groups, pass health checks within 30 seconds, and begin sharing the request load.

```
[Traffic Spike] ──► [Average ASG CPU > 70%] ──(Target Tracking policy fires)──► [ASG spins up new t3.small instances]
                                                                                            │
                                                                                    (App runs automatically)
                                                                                            │
                                                                                            ▼
[ALB health checks pass] ◄──(Auto-registers with Target Group)◄──────────────────────────────┘
```

---

## 10. Monitoring & Troubleshooting

### Common Challenges Faced & Resolved

#### 1. MongoDB `authSource=fanvault_db` Connection Error
- **The Issue**: App instances failed to connect to MongoDB, throwing connection timeouts or unauthorized errors.
- **The Cause**: The database user `dbuser` was created inside the `fanvault_db` database, but the Node.js connection string did not specify an `authSource` parameter. By default, MongoDB driver libraries assume user accounts are stored in the `admin` database, resulting in authentication failures.
- **The Resolution**: Updated the connection URI to explicitly include the authentication database parameter:
  `MONGO_URI=mongodb://dbuser:password@db.fanvault.internal:27017/fanvault_db?authSource=fanvault_db`

#### 2. Frontend React monorepo build paths (ENOENT)
- **The Issue**: Building the frontend in a monorepo threw file not found errors (`ENOENT`).
- **The Cause**: Relative build scripts in `package.json` pointed to standard roots instead of nesting deep inside the new monorepo layout.
- **The Resolution**: Re-mapped folder paths in `vite.config.js` and relative monorepo dependency references, ensuring builds compile cleanly.

#### 3. Lambda Binary PNG Asset Corruption
- **The Issue**: Hitting `arch.fanvault.com` returned garbled, broken text characters instead of the architectural image.
- **The Cause**: Application Load Balancer treats Lambda responses as string text by default, which corrupts binary image data during transmission.
- **The Resolution**: Modified the Lambda function's handler response to:
  1. Retrieve the file from S3 and convert the buffer to a Base64 string.
  2. Set `isBase64Encoded: true` in the ALB response payload.
  3. Include a `Content-Type: image/png` HTTP header.

#### 4. Route53 cross-region association constraint
- **The Issue**: You could not link `db.fanvault.internal` to the database VPC using the AWS Console.
- **The Cause**: The AWS Management Console does not support associating a Route53 Private Hosted Zone with a VPC located in a different AWS region.
- **The Resolution**: Used the AWS CLI from the administrator terminal to force the cross-region VPC association:
  ```bash
  aws route53 associate-vpc-with-hosted-zone --hosted-zone-id Z0987654 --vpc VPCRegion=ap-southeast-1,VPCId=vpc-0db123
  ```

---

## 11. Important Commands Used

### Terraform Infrastructure Management
```bash
terraform init          # Downloads provider plugins and initializes the backend S3 storage.
terraform plan          # Performs a dry run to preview changes before provisioning.
terraform apply         # Provisions resources on AWS to match the declarative code configuration.
terraform destroy       # Safely tears down all managed infrastructure.
terraform state list    # Lists every resource tracked inside the active state file.
```

### AWS CLI Operations
```bash
# Force cross-region Hosted Zone association
aws route53 associate-vpc-with-hosted-zone \
  --hosted-zone-id Z089547376GHTD \
  --vpc VPCRegion=ap-southeast-1,VPCId=vpc-0db12345ab6789

# Test secure SSH access to a private instance using EC2 Instance Connect (EIC)
aws ec2-instance-connect ssh \
  --instance-id i-0123456789abcdef0 \
  --region ap-southeast-1
```

### Linux Instance and systemd Administration
```bash
# Check service logs in real time
journalctl -u fanvault-auth -f --no-pager

# Reload systemd configuration after modifying a service file
sudo systemctl daemon-reload

# Configure the service to start automatically when the instance boots
sudo systemctl enable fanvault-auth

# Restart the service
sudo systemctl restart fanvault-auth
```

### SSH Agent Forwarding (Bastion Jump)
```bash
# On your local machine: Add your private key to the SSH agent
ssh-add -K fanvault-key.pem

# Connect to the public Bastion host while forwarding your SSH keys
ssh -A ubuntu@<BASTION-PUBLIC-IP>

# From the Bastion, connect securely to your private database instance without exposing key files on the Bastion
ssh ubuntu@<DB-PRIVATE-IP>
```

---

## 12. Expected Interview Questions

### 1. Beginner Questions
- **Q**: What is the difference between a security group and a network ACL?
  - **A**: Security groups are **stateful** and operate at the virtual interface layer (blocking or allowing specific traffic to an instance). Network ACLs are **stateless** and operate at the subnet boundary layer, requiring explicit inbound and outbound rules.
- **Q**: Why are your application servers in private subnets?
  - **A**: Placing instances in private subnets blocks all inbound connections from the public internet. This protects them from scanning and automated attacks, allowing them to accept traffic only via the load balancer.

### 2. Intermediate Questions
- **Q**: How does the Application Load Balancer determine where to route a request?
  - **A**: The ALB uses listener rules evaluated by priority. It inspects the host header (e.g. `arch.fanvault.com`) and URI paths (e.g. `/api/auth/*`) to match incoming requests to their respective Target Groups.
- **Q**: Why did you merge the original 6 microservices into 3 for FanVault v2?
  - **A**: The original 6 microservices created excessive network overhead and latency. For example, checkout operations required multiple inter-service HTTP calls just to fetch user profiles and inventory details. Merging them into Frontend, Identity, and Commerce services consolidated related domain boundaries and reduced network latency to zero for these operations.

### 3. Advanced Architecture Questions
- **Q**: Why choose VPC Peering over Transit Gateway or a VPN?
  - **A**: VPC Peering uses the AWS backbone network, offering high performance and low latency without the overhead of encryption tunnels. Because we only needed to connect two VPCs, VPC Peering was the most cost-effective and simple solution. Transit Gateway is designed for hub-and-spoke networks with tens or hundreds of VPCs, which would be over-engineered for this project.
- **Q**: How does cross-region latency affect database queries between Mumbai and Singapore?
  - **A**: Inter-region latency between Mumbai and Singapore is typically 30-50ms. To prevent this from slowing down the application, we use stateless JWT authentication to eliminate session validation queries, retrieve multiple records in a single query (batching), and rely on local caches for static product catalog data.

### 4. Scenario-Based Questions
- **Q**: What happens if the NAT Gateway in your public subnet is deleted?
  - **A**: Private EC2 instances will lose all outbound internet access. They will not be able to download node packages, run updates, or reach external APIs. However, they will still be able to communicate with the database via VPC Peering and accept incoming user traffic through the ALB, as internal VPC routing remains unaffected.
- **Q**: How would you handle a database failure in Singapore?
  - **A**: In a production environment, MongoDB would be deployed as a **Replica Set** spanning multiple Availability Zones. If the primary database node fails, MongoDB automatically elects a secondary node to take over as primary within seconds. The application servers connect using a connection string that includes all replica set members, ensuring automatic failover.

---

## 13. Strong Answers for Interview

### "Why did you choose this architecture?"
> *"I designed this architecture to prioritize **Security, Reliability, and Operational Simplicity**. By consolidating the original 6 microservices into 3, we eliminated unnecessary network latency while retaining clear microservice domain boundaries. 
>
> Placing all application and database instances in private subnets, chaining security groups, and routing traffic through an Application Load Balancer enforces a strict defense-in-depth security model. The cross-region database isolation mimics an enterprise environment where customer transaction data is isolated in a separate, dedicated secure enclave."*

### "Why did you choose EC2 over ECS Fargate or Kubernetes?"
> *"For this project, EC2 was selected to demonstrate a deep understanding of core systems administration and cloud infrastructure. Using EC2 required configuring systemd processes, managing AMI bakes, setting up NAT translation paths, and orchestrating Auto Scaling Groups manually. This provides a strong foundation in cloud systems engineering. 
>
> In a future roadmap, migrating these services to containers on AWS ECS Fargate or EKS would be the logical next step to reduce operational overhead."*

### "How did you implement security at the network and data layers?"
> *"Security is applied at every layer of the stack. At the network layer, we use private subnets to block public ingress, require SSH access to go through a secure public Bastion host using SSH Agent Forwarding, and use strict security group chaining. 
>
> At the database layer, MongoDB is isolated in a dedicated VPC in another region with no internet access. The database is bound to private IPs only, has authentication enabled with strict database-level roles (`authSource`), and encrypts all cross-region traffic automatically over the AWS Private Backbone."*

---

## 14. Architecture Justification

### Enterprise Best Practices Followed
The FanVault v2 design closely aligns with the **AWS Well-Architected Framework**:

1. **Security (Defense-in-Depth)**:
   - Public traffic is terminated at the ALB.
   - Applications are isolated in private subnets.
   - Database traffic is restricted using source-group chaining.
   - Bastion hosts require SSH agent forwarding, ensuring private keys are never uploaded to the cloud.
2. **Reliability (High Availability)**:
   - Infrastructure is deployed across multiple Availability Zones.
   - Auto Scaling Groups scale out automatically when CPU utilization exceeds 70%.
   - The ALB automatically routes around unhealthy instances using continuous health checks.
3. **Performance Efficiency**:
   - Monolith services are split into independent domain boundaries (Identity, Commerce, Frontend).
   - High-throughput static web content is served via Nginx.
   - Advanced routing rules are processed at the ALB edge rather than using proxy servers.
4. **Cost Optimization**:
   - Using Lambda to serve the static architecture page prevents paying for an idle, 24/7 EC2 instance.
   - Burst-capable EC2 instances (`t3.small` and `t3.medium`) provide cost-effective baseline performance with the ability to handle traffic spikes.
   - ACM provides free, auto-renewing SSL certificates.

---

## 15. Revision Cheatsheet

### Quick Concept Map
- **Primary VPC**: `10.0.0.0/16` (Mumbai) $\rightarrow$ Runs ALB, NAT, Bastion, and Application ASGs.
- **Database VPC**: `10.1.0.0/16` (Singapore) $\rightarrow$ Hosts the MongoDB database server.
- **Port 80**: Public ALB ingress (redirects to 443) and Nginx frontend servers.
- **Port 3001**: Identity Service.
- **Port 3002**: Commerce Service.
- **Port 27017**: MongoDB Private Port.
- **Route53 PHZ**: Resolves `db.fanvault.internal` $\rightarrow$ `10.1.31.100` (via Peering).

### Essential Command Flashcards
- **See app logs**: `journalctl -u fanvault-auth -f`
- **Associate Hosted Zone cross-region**: `aws route53 associate-vpc-with-hosted-zone`
- **Verify DB port connectivity**: `nc -zv db.fanvault.internal 27017`
- **Check MongoDB status**: `mongosh --eval "db.adminCommand('ping')"`

### One-Day-Before Review Checklist
- [ ] Memorize the CIDR blocks (`10.0.0.0/16` for Mumbai and `10.1.0.0/16` for Singapore).
- [ ] Be ready to explain why the database user required the `authSource=fanvault_db` parameter.
- [ ] Understand the difference between path-based and host-based ALB routing rules.
- [ ] Be prepared to explain how SSH Agent Forwarding (`ssh -A`) keeps your private keys secure.
- [ ] Re-read the stateless JWT authentication flow and explain how it removes service-to-service dependencies.


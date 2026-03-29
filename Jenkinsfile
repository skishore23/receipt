#!groovy
/*
 * Receipt — Jenkins Pipeline (Pipeline as Code)
 *
 * Prerequisites
 *   - Plugins: Pipeline, Pipeline: Stage View, Credentials Binding,
 *     SSH Agent (or Credentials with "SSH Username with private key")
 *   - Optional — Docker Pipeline: agent runs inside oven/bun image (needs Docker on the Jenkins agent)
 *
 * Job tips
 *   - Multibranch Pipeline: point at this repo; Jenkins discovers Jenkinsfile on each branch
 *   - First multibranch scan may not show parameters until after one run (or configure parameters in job UI)
 *
 * Optional deploy credentials (Jenkins → Manage Credentials)
 *   - receipt-ec2-ssh   → SSH Username with private key (username ec2-user, key = your .pem)
 *   - receipt-ec2-host  → Secret text → instance public hostname or IPv4
 *
 * Deploy runs only when: branch is main AND parameter DEPLOY_TO_EC2 is checked.
 */

pipeline {
    agent none

    options {
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
        disableConcurrentBuilds()
    }

    parameters {
        booleanParam(
            name: 'DEPLOY_TO_EC2',
            defaultValue: false,
            description: 'After a successful verify on main, pull/build/restart on EC2 (requires credentials)',
        )
    }

    stages {
        stage('Verify') {
            agent {
                docker {
                    image 'oven/bun:1'
                    args '-u root'
                }
            }
            steps {
                checkout scm
                sh '''#!/usr/bin/env bash
set -euo pipefail
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ripgrep git ca-certificates
  rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache ripgrep git ca-certificates
fi
'''
                sh 'bun install --frozen-lockfile'
                sh 'bun run verify'
            }
        }

        stage('Deploy EC2') {
            when {
                allOf {
                    branch 'main'
                    expression { return params.DEPLOY_TO_EC2 }
                }
            }
            agent any
            steps {
                withCredentials([
                    sshUserPrivateKey(
                        credentialsId: 'receipt-ec2-ssh',
                        keyFileVariable: 'SSH_KEY_FILE',
                        usernameVariable: 'SSH_USER',
                    ),
                    string(credentialsId: 'receipt-ec2-host', variable: 'EC2_HOST'),
                ]) {
                    sh '''#!/usr/bin/env bash
set -euo pipefail
ssh \
  -i "$SSH_KEY_FILE" \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no \
  "$SSH_USER@$EC2_HOST" \
  bash -s <<'REMOTE'
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
BUN=/home/ec2-user/.bun/bin/bun
APP=/home/ec2-user/receipt
cd "$APP"
git fetch origin main
git checkout main
git pull --ff-only origin main
"$BUN" install --frozen-lockfile
"$BUN" run build
sudo /usr/bin/systemctl restart receipt
REMOTE
'''
                }
            }
        }
    }

    post {
        unsuccessful {
            echo 'Pipeline did not complete successfully — see stage logs above.'
        }
    }
}

# Eliza Docker Setup Guide

This guide describes the production Docker image for the SentiEdge agent. The root `Dockerfile` builds and runs the agent service only on port `3000`.

## Prerequisites

- A Linux-based server (Ubuntu/Debian recommended)
- Git installed
- Docker (optional, for containerized deployment)

1. **Install NVM**:

    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.1/install.sh | bash
    source ~/.bashrc
    nvm install v23.3.0
    ```

2. **Install Build Essentials** (Optional):

    ```bash
    apt install -y build-essential
    ```

3. **Install PNPM**:
    ```bash
    curl -fsSL https://get.pnpm.io/install.sh | sh -
    source /root/.bashrc
    ```

## Docker Installation

1. **Install Docker**:

    ```bash
    # Add Docker's official GPG key
    sudo apt-get update
    sudo apt-get install ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc

    # Add Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Install Docker packages
    sudo apt-get update
    sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ```

2. **Clone the Repository**:

    ```bash
    git clone https://github.com/YOUR_USERNAME/eliza.git
    cd eliza
    ```

3. **Configure Environment**:

    ```bash
    cp .env.example .env
    ```

4. **Fix Unix Script Issues** (if needed):

    ```bash
    apt install dos2unix
    dos2unix ./scripts/*
    ```

5. **Build the Production Image**:
    ```bash
    pnpm docker:build
    ```

6. **Run the Production Image**:
    ```bash
    pnpm docker:run
    ```

    The run command expects a local `.env` file. For Amazon DocumentDB, set `MONGODB_CONNECTION_STRING` with `tls=true&tlsCAFile=/app/global-bundle.pem`.

## Docker Management Commands

- Check running containers:

    ```bash
    docker ps
    ```

- Stop the running container:

    Press `Ctrl+C` in the terminal where `pnpm docker:run` is attached, or stop it from another shell:

    ```bash
    docker ps
    docker stop <container-id>
    ```

## Customization

- Modify the `.env` file to customize your bot's settings
- Character files are located in the `characters/` directory
- Create new character files by copying and modifying existing ones

## Troubleshooting

- If the container fails to start, rerun `pnpm docker:run` in the foreground and inspect the startup logs.
- For permission issues, ensure proper file ownership and permissions
- For script formatting issues, run `dos2unix` on problematic files

- Remove All Docker Images
    - Run the following command to delete all images:

```bash
docker rmi -f $(docker images -aq)
```

- Remove All Build Cache
    - To clear the build cache entirely, use:
    ```bash
    docker builder prune -a -f
    ```
- Verify Cleanup
    - Check Docker disk usage again to ensure everything is removed:

```bash
docker system df
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

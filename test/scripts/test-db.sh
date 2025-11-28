#!/bin/bash

# Script to manage Docker PostgreSQL for integration tests

set -e

COMPOSE_FILE="docker-compose.test.yml"

case "$1" in
  start)
    echo "Starting PostgreSQL test containers..."
    docker compose -f $COMPOSE_FILE up -d
    echo "Waiting for PostgreSQL to be ready..."
    sleep 5
    docker compose -f $COMPOSE_FILE exec -T postgres-source pg_isready -U test_user -d seed_it_test
    docker compose -f $COMPOSE_FILE exec -T postgres-target pg_isready -U test_user -d seed_it_test_target
    echo "PostgreSQL containers are ready!"
    echo "  Source DB: localhost:5433/seed_it_test"
    echo "  Target DB: localhost:5434/seed_it_test_target"
    ;;
  
  stop)
    echo "Stopping PostgreSQL test containers..."
    docker compose -f $COMPOSE_FILE down
    ;;
  
  restart)
    $0 stop
    $0 start
    ;;
  
  clean)
    echo "Stopping and removing PostgreSQL test containers and volumes..."
    docker compose -f $COMPOSE_FILE down -v
    ;;
  
  logs)
    echo "Select database: [s]ource or [t]arget?"
    read -r choice
    case "$choice" in
      s|source)
        docker compose -f $COMPOSE_FILE logs -f postgres-source
        ;;
      t|target)
        docker compose -f $COMPOSE_FILE logs -f postgres-target
        ;;
      *)
        echo "Showing both logs..."
        docker compose -f $COMPOSE_FILE logs -f
        ;;
    esac
    ;;
  
  psql)
    echo "Connect to: [s]ource or [t]arget?"
    read -r choice
    case "$choice" in
      s|source)
        docker compose -f $COMPOSE_FILE exec postgres-source psql -U test_user -d seed_it_test
        ;;
      t|target)
        docker compose -f $COMPOSE_FILE exec postgres-target psql -U test_user -d seed_it_test_target
        ;;
      *)
        echo "Invalid choice. Use 's' for source or 't' for target."
        exit 1
        ;;
    esac
    ;;
  
  *)
    echo "Usage: $0 {start|stop|restart|clean|logs|psql}"
    exit 1
    ;;
esac

#!/bin/bash
# PI/PO 7.50 Artifact Discovery Test Script (Bash/Curl version)
# Run on jump server: chmod +x test-pipo.sh && ./test-pipo.sh

PIPO_HOST="pj2sda.consultsda.com"
PIPO_PORT="50000"
PIPO_USER="SDAINT"
PIPO_PASS="SDAINT"  # Change this to actual password

echo "=============================================="
echo "PI/PO 7.50 Discovery Test"
echo "Host: $PIPO_HOST:$PIPO_PORT"
echo "User: $PIPO_USER"
echo "=============================================="

# Test 1: Simple Query - SoftwareComponentVersion
echo ""
echo "--- Test 1: Simple Query (SoftwareComponentVersion) ---"
curl -s -u "$PIPO_USER:$PIPO_PASS" \
  "http://$PIPO_HOST:$PIPO_PORT/rep/support/SimpleQuery?type=SoftwareComponentVersion" \
  | head -50

# Test 2: Simple Query - IntegratedConfiguration  
echo ""
echo "--- Test 2: Simple Query (IntegratedConfiguration) ---"
curl -s -u "$PIPO_USER:$PIPO_PASS" \
  "http://$PIPO_HOST:$PIPO_PORT/rep/support/SimpleQuery?type=IntegratedConfiguration" \
  | head -50

# Test 3: REP Query API
echo ""
echo "--- Test 3: REP Query API ---"
curl -s -u "$PIPO_USER:$PIPO_PASS" \
  "http://$PIPO_HOST:$PIPO_PORT/rep/query/ext/1/SoftwareComponentVersion" \
  | head -20

# Test 4: DIR Query API
echo ""
echo "--- Test 4: DIR Query API ---"
curl -s -u "$PIPO_USER:$PIPO_PASS" \
  "http://$PIPO_HOST:$PIPO_PORT/dir/query/ext/1/IntegratedConfiguration" \
  | head -20

# Test 5: Services Registry
echo ""
echo "--- Test 5: Services Registry ---"
curl -s -u "$PIPO_USER:$PIPO_PASS" \
  "http://$PIPO_HOST:$PIPO_PORT/sr" \
  | head -20

# Test 6: MDT Monitoring
echo ""
echo "--- Test 6: MDT Monitoring API ---"
curl -s -u "$PIPO_USER:$PIPO_PASS" \
  "http://$PIPO_HOST:$PIPO_PORT/mdt/api/1.0/MessageProcessingLogs?\$top=1" \
  | head -20

echo ""
echo "=============================================="
echo "Test Complete"
echo "=============================================="